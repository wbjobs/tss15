use wasm_bindgen::prelude::*;
use wasm_bindgen::Clamped;
use web_sys::console;

mod vec3;
mod ray;
mod sphere;
mod plane;
mod material;
mod scene;
mod camera;

use vec3::Vec3;
use scene::Scene;
use camera::Camera;

#[wasm_bindgen]
pub struct Renderer {
    scene: Scene,
    camera: Camera,
    width: u32,
    height: u32,
    samples_per_pixel: u32,
}

#[wasm_bindgen]
impl Renderer {
    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32, samples_per_pixel: u32) -> Renderer {
        console_error_panic_hook::set_once();
        
        let camera = Camera::new(
            Vec3::new(0.0, 2.0, 5.0),
            Vec3::new(0.0, 0.0, 0.0),
            60.0,
            width as f32 / height as f32,
        );

        let mut scene = Scene::new();
        
        scene.add_sphere(
            Vec3::new(0.0, 0.5, 0.0),
            0.5,
            material::Material::diffuse(Vec3::new(0.8, 0.3, 0.3)),
        );
        
        scene.add_sphere(
            Vec3::new(-1.2, 0.3, 0.0),
            0.3,
            material::Material::metal(Vec3::new(0.9, 0.9, 0.9), 0.1),
        );
        
        scene.add_sphere(
            Vec3::new(1.2, 0.35, 0.2),
            0.35,
            material::Material::diffuse(Vec3::new(0.3, 0.5, 0.9)),
        );
        
        scene.add_sphere(
            Vec3::new(0.5, -0.3, -0.8),
            0.2,
            material::Material::emissive(Vec3::new(2.0, 2.0, 1.5)),
        );
        
        scene.add_plane(
            Vec3::new(0.0, -0.5, 0.0),
            Vec3::new(0.0, 1.0, 0.0),
            material::Material::diffuse(Vec3::new(0.6, 0.6, 0.6)),
        );

        Renderer {
            scene,
            camera,
            width,
            height,
            samples_per_pixel,
        }
    }

    pub fn set_camera(&mut self, pos_x: f32, pos_y: f32, pos_z: f32,
                      target_x: f32, target_y: f32, target_z: f32,
                      fov: f32) {
        self.camera = Camera::new(
            Vec3::new(pos_x, pos_y, pos_z),
            Vec3::new(target_x, target_y, target_z),
            fov,
            self.width as f32 / self.height as f32,
        );
    }

    pub fn render_tile(&self, tile_x: u32, tile_y: u32, 
                       tile_width: u32, tile_height: u32) -> Clamped<Vec<u8>> {
        let mut pixels = Vec::with_capacity((tile_width * tile_height * 4) as usize);
        let mut rng = rand::thread_rng();

        for py in 0..tile_height {
            for px in 0..tile_width {
                let mut color = Vec3::zero();
                
                for _s in 0..self.samples_per_pixel {
                    let u = ((tile_x + px) as f32 + rand::random::<f32>()) / self.width as f32;
                    let v = 1.0 - ((tile_y + py) as f32 + rand::random::<f32>()) / self.height as f32;
                    
                    let ray = self.camera.get_ray(u, v);
                    color += self.trace_ray(&ray, 5);
                }
                
                color /= self.samples_per_pixel as f32;
                
                let r = (color.x.powf(1.0 / 2.2).clamp(0.0, 1.0) * 255.0) as u8;
                let g = (color.y.powf(1.0 / 2.2).clamp(0.0, 1.0) * 255.0) as u8;
                let b = (color.z.powf(1.0 / 2.2).clamp(0.0, 1.0) * 255.0) as u8;
                
                pixels.push(r);
                pixels.push(g);
                pixels.push(b);
                pixels.push(255);
            }
        }

        Clamped(pixels)
    }

    fn trace_ray(&self, ray: &ray::Ray, depth: i32) -> Vec3 {
        if depth <= 0 {
            return Vec3::zero();
        }

        if let Some(hit) = self.scene.hit(ray, 0.001, f32::INFINITY) {
            if hit.material.is_emissive() {
                return hit.material.emission();
            }

            let scattered = hit.material.scatter(ray, &hit);
            let attenuation = hit.material.color();
            
            let incoming = self.trace_ray(&scattered, depth - 1);
            return attenuation * incoming;
        }

        let t = 0.5 * (ray.direction.y + 1.0);
        Vec3::new(1.0, 1.0, 1.0) * (1.0 - t) + Vec3::new(0.5, 0.7, 1.0) * t
    }
}

pub fn console_log(s: &str) {
    console::log_1(&JsValue::from_str(s));
}
