use std::error::Error;
use std::slice;

use windows::Graphics::DirectX::Direct3D11::IDirect3DSurface;
use windows::Win32::Graphics::Direct3D::Fxc::{D3DCOMPILE_ENABLE_STRICTNESS, D3DCompile};
use windows::Win32::Graphics::Direct3D::{D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST, ID3DBlob};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_COMPARISON_NEVER,
    D3D11_FILTER_MIN_MAG_MIP_LINEAR, D3D11_SAMPLER_DESC, D3D11_TEXTURE_ADDRESS_CLAMP,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, D3D11_VIEWPORT, ID3D11Device, ID3D11DeviceContext,
    ID3D11PixelShader, ID3D11SamplerState, ID3D11ShaderResourceView, ID3D11Texture2D,
    ID3D11VertexShader,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::IDXGISurface;
use windows::Win32::System::WinRT::Direct3D11::CreateDirect3D11SurfaceFromDXGISurface;
use windows::core::{Interface, PCSTR};
use windows_capture::frame::Frame;

type ScaleError = Box<dyn Error + Send + Sync>;

// Bilinear sampling at the centre of every output pixel. For the common 2:1 case
// (3840x2160 -> 1920x1080) each output pixel lands exactly between four source
// pixels, which makes this an exact 2x2 box average instead of dropping three of
// every four pixels. Other ratios (for example 2560x1440 -> 1920x1080) get a
// plain bilinear resize.
const SCALE_SHADER: &str = r#"
Texture2D<float4> SourceTexture : register(t0);
SamplerState LinearSampler : register(s0);

struct VertexOutput
{
    float4 Position : SV_Position;
    float2 TexCoord : TEXCOORD0;
};

VertexOutput vs_main(uint vertexId : SV_VertexID)
{
    VertexOutput output;
    float2 uv = float2((vertexId << 1) & 2, vertexId & 2);
    output.TexCoord = uv;
    output.Position = float4(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
    return output;
}

float4 ps_main(VertexOutput input) : SV_Target
{
    float3 color = SourceTexture.SampleLevel(LinearSampler, input.TexCoord, 0).rgb;
    return float4(color, 1.0);
}
"#;

fn compile_shader(entry: &'static [u8], target: &'static [u8]) -> Result<Vec<u8>, ScaleError> {
    let mut code: Option<ID3DBlob> = None;
    let mut errors: Option<ID3DBlob> = None;
    let compile_result = unsafe {
        D3DCompile(
            SCALE_SHADER.as_ptr().cast(),
            SCALE_SHADER.len(),
            PCSTR::null(),
            None,
            None,
            PCSTR(entry.as_ptr()),
            PCSTR(target.as_ptr()),
            D3DCOMPILE_ENABLE_STRICTNESS,
            0,
            &mut code,
            Some(&mut errors),
        )
    };
    if let Err(error) = compile_result {
        let details = errors
            .as_ref()
            .map(|blob| unsafe {
                let bytes = slice::from_raw_parts(
                    blob.GetBufferPointer().cast::<u8>(),
                    blob.GetBufferSize(),
                );
                String::from_utf8_lossy(bytes).trim().to_string()
            })
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| error.to_string());
        return Err(format!("Downscale shader compilation failed: {details}").into());
    }
    let code = code.ok_or("Downscale shader compiler returned no bytecode")?;
    let bytes = unsafe {
        slice::from_raw_parts(code.GetBufferPointer().cast::<u8>(), code.GetBufferSize())
    };
    Ok(bytes.to_vec())
}

/// Resizes captured BGRA8 frames on the GPU so the encoder only has to handle the
/// smaller picture. Frames never touch system memory.
pub struct Downscaler {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    source_width: u32,
    source_height: u32,
    output_width: u32,
    output_height: u32,
    input_texture: ID3D11Texture2D,
    input_view: ID3D11ShaderResourceView,
    vertex_shader: ID3D11VertexShader,
    pixel_shader: ID3D11PixelShader,
    sampler: ID3D11SamplerState,
}

impl Downscaler {
    pub fn new(
        device: ID3D11Device,
        context: ID3D11DeviceContext,
        source_width: u32,
        source_height: u32,
        output_width: u32,
        output_height: u32,
    ) -> Result<Self, ScaleError> {
        if source_width == 0 || source_height == 0 || output_width == 0 || output_height == 0 {
            return Err("Downscaler needs non-zero dimensions".into());
        }
        let vertex_bytecode = compile_shader(b"vs_main\0", b"vs_5_0\0")?;
        let pixel_bytecode = compile_shader(b"ps_main\0", b"ps_5_0\0")?;

        let mut vertex_shader = None;
        let mut pixel_shader = None;
        unsafe {
            device.CreateVertexShader(&vertex_bytecode, None, Some(&mut vertex_shader))?;
            device.CreatePixelShader(&pixel_bytecode, None, Some(&mut pixel_shader))?;
        }
        let vertex_shader = vertex_shader.ok_or("D3D11 returned no downscale vertex shader")?;
        let pixel_shader = pixel_shader.ok_or("D3D11 returned no downscale pixel shader")?;

        let input_desc = D3D11_TEXTURE2D_DESC {
            Width: source_width,
            Height: source_height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let mut input_texture = None;
        unsafe { device.CreateTexture2D(&input_desc, None, Some(&mut input_texture))? };
        let input_texture = input_texture.ok_or("D3D11 returned no downscale input texture")?;
        let mut input_view = None;
        unsafe { device.CreateShaderResourceView(&input_texture, None, Some(&mut input_view))? };
        let input_view = input_view.ok_or("D3D11 returned no downscale shader-resource view")?;

        let sampler_desc = D3D11_SAMPLER_DESC {
            Filter: D3D11_FILTER_MIN_MAG_MIP_LINEAR,
            AddressU: D3D11_TEXTURE_ADDRESS_CLAMP,
            AddressV: D3D11_TEXTURE_ADDRESS_CLAMP,
            AddressW: D3D11_TEXTURE_ADDRESS_CLAMP,
            MipLODBias: 0.0,
            MaxAnisotropy: 1,
            ComparisonFunc: D3D11_COMPARISON_NEVER,
            BorderColor: [0.0; 4],
            MinLOD: 0.0,
            MaxLOD: f32::MAX,
        };
        let mut sampler = None;
        unsafe { device.CreateSamplerState(&sampler_desc, Some(&mut sampler))? };
        let sampler = sampler.ok_or("D3D11 returned no downscale sampler")?;

        Ok(Self {
            device,
            context,
            source_width,
            source_height,
            output_width,
            output_height,
            input_texture,
            input_view,
            vertex_shader,
            pixel_shader,
            sampler,
        })
    }

    /// Renders `source` (BGRA8, the size given to `new`) into a new output texture.
    pub fn convert_texture(&self, source: &ID3D11Texture2D) -> Result<ID3D11Texture2D, ScaleError> {
        let output_desc = D3D11_TEXTURE2D_DESC {
            Width: self.output_width,
            Height: self.output_height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let mut output_texture = None;
        unsafe {
            self.device
                .CreateTexture2D(&output_desc, None, Some(&mut output_texture))?
        };
        let output_texture = output_texture.ok_or("D3D11 returned no downscale output texture")?;
        let mut render_target = None;
        unsafe {
            self.device
                .CreateRenderTargetView(&output_texture, None, Some(&mut render_target))?
        };
        let render_target =
            render_target.ok_or("D3D11 returned no downscale render-target view")?;

        unsafe {
            self.context.CopyResource(&self.input_texture, source);
            self.context.IASetInputLayout(None);
            self.context
                .IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            self.context.VSSetShader(&self.vertex_shader, None);
            self.context.PSSetShader(&self.pixel_shader, None);
            self.context
                .PSSetShaderResources(0, Some(&[Some(self.input_view.clone())]));
            self.context
                .PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
            self.context
                .OMSetRenderTargets(Some(&[Some(render_target)]), None);
            self.context.RSSetViewports(Some(&[D3D11_VIEWPORT {
                TopLeftX: 0.0,
                TopLeftY: 0.0,
                Width: self.output_width as f32,
                Height: self.output_height as f32,
                MinDepth: 0.0,
                MaxDepth: 1.0,
            }]));
            self.context.Draw(3, 0);
            self.context.ClearState();
            self.context.Flush();
        }
        Ok(output_texture)
    }

    pub fn convert(&self, frame: &Frame) -> Result<IDirect3DSurface, ScaleError> {
        if frame.width() != self.source_width || frame.height() != self.source_height {
            return Err("Capture dimensions changed while recording".into());
        }
        let output_texture = self.convert_texture(frame.as_raw_texture())?;
        let dxgi_surface: IDXGISurface = output_texture.cast()?;
        let inspectable = unsafe { CreateDirect3D11SurfaceFromDXGISurface(&dxgi_surface)? };
        Ok(inspectable.cast()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Foundation::HMODULE;
    use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_WARP;
    use windows::Win32::Graphics::Direct3D11::{
        D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ,
        D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION, D3D11_SUBRESOURCE_DATA, D3D11_USAGE_STAGING,
        D3D11CreateDevice,
    };

    fn warp_device() -> Option<(ID3D11Device, ID3D11DeviceContext)> {
        let mut device = None;
        let mut context = None;
        unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_WARP,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
            .ok()?;
        }
        Some((device?, context?))
    }

    fn texture_from_bgra(
        device: &ID3D11Device,
        width: u32,
        height: u32,
        pixels: &[u8],
    ) -> ID3D11Texture2D {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let initial = D3D11_SUBRESOURCE_DATA {
            pSysMem: pixels.as_ptr().cast(),
            SysMemPitch: width * 4,
            SysMemSlicePitch: 0,
        };
        let mut texture = None;
        unsafe {
            device
                .CreateTexture2D(&desc, Some(&initial), Some(&mut texture))
                .expect("source texture");
        }
        texture.expect("source texture")
    }

    fn read_back(
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        texture: &ID3D11Texture2D,
        width: u32,
        height: u32,
    ) -> Vec<u8> {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
        };
        let mut staging = None;
        unsafe {
            device
                .CreateTexture2D(&desc, None, Some(&mut staging))
                .expect("staging texture");
        }
        let staging = staging.expect("staging texture");
        let mut out = Vec::new();
        unsafe {
            context.CopyResource(&staging, texture);
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            context
                .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                .expect("map staging texture");
            for row in 0..height as usize {
                let start = (mapped.pData as *const u8).add(row * mapped.RowPitch as usize);
                out.extend_from_slice(slice::from_raw_parts(start, width as usize * 4));
            }
            context.Unmap(&staging, 0);
        }
        out
    }

    #[test]
    fn two_to_one_downscale_averages_each_two_by_two_block() {
        let Some((device, context)) = warp_device() else {
            eprintln!("no WARP device available; skipping the GPU downscale test");
            return;
        };
        // 4x4 BGRA source = four 2x2 blocks.
        //  block (0,0): black/white checker  -> mid grey
        //  block (1,0): solid red            -> red
        //  block (0,1): left blue, right green -> half blue + half green
        //  block (1,1): solid (10, 20, 30)   -> unchanged
        let px = |b: u8, g: u8, r: u8| [b, g, r, 255u8];
        let rows: [[[u8; 4]; 4]; 4] = [
            [px(0, 0, 0), px(255, 255, 255), px(0, 0, 255), px(0, 0, 255)],
            [px(255, 255, 255), px(0, 0, 0), px(0, 0, 255), px(0, 0, 255)],
            [px(255, 0, 0), px(0, 255, 0), px(10, 20, 30), px(10, 20, 30)],
            [px(255, 0, 0), px(0, 255, 0), px(10, 20, 30), px(10, 20, 30)],
        ];
        let mut source_pixels = Vec::new();
        for row in rows {
            for pixel in row {
                source_pixels.extend_from_slice(&pixel);
            }
        }
        let source = texture_from_bgra(&device, 4, 4, &source_pixels);
        let scaler = Downscaler::new(device.clone(), context.clone(), 4, 4, 2, 2)
            .expect("downscaler");
        let output = scaler.convert_texture(&source).expect("convert");
        let result = read_back(&device, &context, &output, 2, 2);

        let expected: [[u8; 4]; 4] = [
            [128, 128, 128, 255], // grey
            [0, 0, 255, 255],     // red
            [128, 128, 0, 255],   // half blue + half green
            [10, 20, 30, 255],    // unchanged
        ];
        for (index, want) in expected.iter().enumerate() {
            let got = &result[index * 4..index * 4 + 4];
            for channel in 0..4 {
                let diff = (i32::from(got[channel]) - i32::from(want[channel])).abs();
                assert!(
                    diff <= 3,
                    "pixel {index} channel {channel}: got {} want {}",
                    got[channel],
                    want[channel]
                );
            }
        }
    }
}
