﻿import { Effect, Selection } from "postprocessing"
import { EquirectangularReflectionMapping, LinearMipMapLinearFilter, Uniform } from "three"
import { SSGIPass } from "./pass/SSGIPass.js"
import compose from "./shader/compose.frag"
import utils from "./shader/utils.frag"
import { defaultSSGIOptions } from "./SSGIOptions"
import { SVGF } from "./SVGF.js"
import { getMaxMipLevel } from "./utils/Utils.js"

const finalFragmentShader = compose.replace("#include <utils>", utils)

export class SSGIEffect extends Effect {
	selection = new Selection()

	/**
	 * @param {THREE.Scene} scene The scene of the SSGI effect
	 * @param {THREE.Camera} camera The camera with which SSGI is being rendered
	 * @param {SSGIOptions} [options] The optional options for the SSGI effect
	 */
	constructor(scene, camera, options = defaultSSGIOptions) {
		options = { ...defaultSSGIOptions, ...options }

		super("SSGIEffect", finalFragmentShader, {
			type: "FinalSSGIMaterial",
			uniforms: new Map([["inputTexture", new Uniform(null)]])
		})

		this._scene = scene
		this._camera = camera

		this.svgf = new SVGF(scene, camera, { reprojectReflectionHitPoints: true })

		// ssgi pass
		this.ssgiPass = new SSGIPass(this)
		this.svgf.setInputTexture(this.ssgiPass.renderTarget.texture)
		this.svgf.setNormalTexture(this.ssgiPass.normalTexture)
		this.svgf.setDepthTexture(this.ssgiPass.depthTexture)
		this.svgf.setVelocityTexture(this.ssgiPass.velocityTexture)

		// modify the temporal resolve pass of SVGF denoiser for the SSGI effect
		this.svgf.svgfTemporalResolvePass.fullscreenMaterial.fragmentShader =
			/* glsl */ `
		uniform sampler2D diffuseTexture;
		uniform sampler2D directLightTexture;
		` + this.svgf.svgfTemporalResolvePass.fullscreenMaterial.fragmentShader

		this.svgf.svgfTemporalResolvePass.fullscreenMaterial.uniforms = {
			...this.svgf.svgfTemporalResolvePass.fullscreenMaterial.uniforms,
			...{
				diffuseTexture: new Uniform(null),
				directLightTexture: new Uniform(null)
			}
		}

		// patch the denoise pass

		this.svgf.denoisePass.fullscreenMaterial.fragmentShader =
			/* glsl */ `
		uniform sampler2D diffuseTexture;
		uniform sampler2D directLightTexture;
		uniform float jitter;
		uniform float jitterRoughness;
		` +
			this.svgf.denoisePass.fullscreenMaterial.fragmentShader
				.replace(
					"gl_FragColor = vec4(color, sumVariance);",
					/* glsl */ `
			if (isLastIteration) {
				roughness = jitter + jitterRoughness * roughness;

				vec4 diffuseTexel = textureLod(diffuseTexture, vUv, 0.);
				vec3 diffuse = diffuseTexel.rgb;
				vec3 directLight = textureLod(directLightTexture, vUv, 0.).rgb;
				float metalness = diffuseTexel.a;
		
				vec3 viewPos = getViewPosition(depth);
				vec3 viewDir = normalize(viewPos);

				float f = fresnel_dielectric(viewDir, viewNormal, 1.75);
		
				float colorLum = czm_luminance(color);
				float diffuseLum = czm_luminance(diffuse);

				float factor = clamp(0.2 + diffuseLum * 0.1 - f * metalness * (1. - roughness) * 0.25, 0., 1.);

				float s = rgb2hsv(diffuse).y;

				color *= mix(diffuse * mix(colorLum, 1., 0.5 + s * s * 0.175), mix(color, vec3(colorLum), 1.), factor);
				color += directLight;
		
				sumVariance = 1.;
			}

			gl_FragColor = vec4(color, sumVariance);
			`
				)
				.replace(
					"void main()",
					/* glsl */ `
			// source: https://github.com/blender/blender/blob/594f47ecd2d5367ca936cf6fc6ec8168c2b360d0/source/blender/gpu/shaders/material/gpu_shader_material_fresnel.glsl
			float fresnel_dielectric_cos(float cosi, float eta) {
				/* compute fresnel reflectance without explicitly computing
				* the refracted direction */
				float c = abs(cosi);
				float g = eta * eta - 1.0 + c * c;
				float result;

				if (g > 0.0) {
					g = sqrt(g);
					float A = (g - c) / (g + c);
					float B = (c * (g + c) - 1.0) / (c * (g - c) + 1.0);
					result = 0.5 * A * A * (1.0 + B * B);
				} else {
					result = 1.0; /* TIR (no refracted component) */
				}

				return result;
			}

			// source: http://lolengine.net/blog/2013/07/27/rgb-to-hsv-in-glsl
			vec3 rgb2hsv(vec3 c)
			{
				vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
				vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
				vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));

				float d = q.x - min(q.w, q.y);
				float e = 1.0e-10;
				return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
			}

			// source: https://github.com/blender/blender/blob/594f47ecd2d5367ca936cf6fc6ec8168c2b360d0/source/blender/gpu/shaders/material/gpu_shader_material_fresnel.glsl
			float fresnel_dielectric(vec3 Incoming, vec3 Normal, float eta) {
				/* compute fresnel reflectance without explicitly computing
				* the refracted direction */

				float cosine = dot(Incoming, Normal);
				return min(1.0, 5.0 * fresnel_dielectric_cos(cosine, eta));
			}

			// source: https://github.com/mrdoob/three.js/blob/dev/examples/js/shaders/SSAOShader.js
			vec3 getViewPosition(const float depth) {
				float clipW = projectionMatrix[2][3] * depth + projectionMatrix[3][3];
				vec4 clipPosition = vec4((vec3(vUv, depth) - 0.5) * 2.0, 1.0);
				clipPosition *= clipW;
				return (_projectionMatrixInverse * clipPosition).xyz;
			}

			void main()
			`
				)

		this.svgf.denoisePass.fullscreenMaterial.uniforms = {
			...this.svgf.denoisePass.fullscreenMaterial.uniforms,
			...{
				directLightTexture: new Uniform(null),
				diffuseTexture: new Uniform(null),
				jitter: new Uniform(0),
				jitterRoughness: new Uniform(0)
			}
		}

		this.svgf.denoisePass.fullscreenMaterial.uniforms.diffuseTexture.value = this.ssgiPass.diffuseTexture

		this.lastSize = {
			width: options.width,
			height: options.height,
			resolutionScale: options.resolutionScale
		}

		this.setSize(options.width, options.height)

		this.makeOptionsReactive(options)
	}

	makeOptionsReactive(options) {
		let needsUpdate = false

		if (options.reflectionsOnly) this.svgf.svgfTemporalResolvePass.fullscreenMaterial.defines.reflectionsOnly = ""

		const ssgiPassFullscreenMaterialUniforms = this.ssgiPass.fullscreenMaterial.uniforms
		const ssgiPassFullscreenMaterialUniformsKeys = Object.keys(ssgiPassFullscreenMaterialUniforms)

		for (const key of Object.keys(options)) {
			Object.defineProperty(this, key, {
				get() {
					return options[key]
				},
				set(value) {
					if (options[key] === value && needsUpdate) return

					options[key] = value

					switch (key) {
						case "resolutionScale":
							this.setSize(this.lastSize.width, this.lastSize.height)
							break

						case "denoiseIterations":
							this.svgf.denoisePass.iterations = value
							break

						case "denoiseKernel":
						case "lumaPhi":
						case "depthPhi":
						case "normalPhi":
						case "roughnessPhi":
						case "curvaturePhi":
							this.svgf.denoisePass.fullscreenMaterial.uniforms[key].value = value
							break

						// defines
						case "steps":
						case "refineSteps":
						case "spp":
							this.ssgiPass.fullscreenMaterial.defines[key] = parseInt(value)
							this.ssgiPass.fullscreenMaterial.needsUpdate = needsUpdate
							break

						case "missedRays":
							if (value) {
								this.ssgiPass.fullscreenMaterial.defines.missedRays = ""
							} else {
								delete this.ssgiPass.fullscreenMaterial.defines.missedRays
							}

							this.ssgiPass.fullscreenMaterial.needsUpdate = needsUpdate
							break

						case "correctionRadius":
							this.svgf.svgfTemporalResolvePass.fullscreenMaterial.defines.correctionRadius = Math.round(value)

							this.svgf.svgfTemporalResolvePass.fullscreenMaterial.needsUpdate = needsUpdate
							break

						case "blend":
						case "correction":
							this.svgf.svgfTemporalResolvePass.fullscreenMaterial.uniforms[key].value = value
							break

						case "distance":
							ssgiPassFullscreenMaterialUniforms.rayDistance.value = value
							break

						case "jitter":
						case "jitterRoughness":
							ssgiPassFullscreenMaterialUniforms[key].value = value

							this.svgf.denoisePass.fullscreenMaterial.uniforms[key].value = value
							break

						// must be a uniform
						default:
							if (ssgiPassFullscreenMaterialUniformsKeys.includes(key)) {
								ssgiPassFullscreenMaterialUniforms[key].value = value
							}
					}
				}
			})

			// apply all uniforms and defines
			this[key] = options[key]
		}

		needsUpdate = true
	}

	initialize(renderer, ...args) {
		super.initialize(renderer, ...args)
		this.ssgiPass.initialize(renderer, ...args)
	}

	setSize(width, height, force = false) {
		if (width === undefined && height === undefined) return
		if (
			!force &&
			width === this.lastSize.width &&
			height === this.lastSize.height &&
			this.resolutionScale === this.lastSize.resolutionScale
		)
			return

		this.ssgiPass.setSize(width, height)
		this.svgf.setSize(width, height)

		if (!this.antialias) this.svgf.svgfTemporalResolvePass.customDepthRenderTarget = this.ssgiPass.gBuffersRenderTarget

		this.lastSize = {
			width,
			height,
			resolutionScale: this.resolutionScale
		}
	}

	dispose() {
		super.dispose()

		this.ssgiPass.dispose()
		this.svgf.dispose()
	}

	keepEnvMapUpdated() {
		const ssgiMaterial = this.ssgiPass.fullscreenMaterial

		if (ssgiMaterial.uniforms.envMap.value !== this._scene.environment) {
			if (this._scene.environment?.mapping === EquirectangularReflectionMapping) {
				ssgiMaterial.uniforms.envMap.value = this._scene.environment

				if (!this._scene.environment.generateMipmaps) {
					this._scene.environment.generateMipmaps = true
					this._scene.environment.minFilter = LinearMipMapLinearFilter
					this._scene.environment.magFilter = LinearMipMapLinearFilter
					this._scene.environment.needsUpdate = true
				}

				const maxEnvMapMipLevel = getMaxMipLevel(this._scene.environment)
				ssgiMaterial.uniforms.maxEnvMapMipLevel.value = maxEnvMapMipLevel

				ssgiMaterial.defines.USE_ENVMAP = ""
			} else {
				ssgiMaterial.uniforms.envMap.value = null
				delete ssgiMaterial.defines.USE_ENVMAP
			}

			ssgiMaterial.needsUpdate = true
		}
	}

	update(renderer, inputBuffer) {
		this.keepEnvMapUpdated()

		this.svgf.svgfTemporalResolvePass.fullscreenMaterial.uniforms.directLightTexture.value = inputBuffer.texture
		this.ssgiPass.fullscreenMaterial.uniforms.directLightTexture.value = inputBuffer.texture
		this.svgf.denoisePass.fullscreenMaterial.uniforms.directLightTexture.value = inputBuffer.texture

		this.ssgiPass.render(renderer, inputBuffer)

		this.svgf.render(renderer)

		this.uniforms.get("inputTexture").value = this.svgf.texture
	}
}
