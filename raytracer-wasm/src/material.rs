use crate::vec3::Vec3;
use crate::ray::Ray;
use crate::hittable::HitRecord;

#[derive(Copy, Clone, Debug)]
pub enum MaterialType {
    Diffuse,
    Metal,
    Emissive,
}

#[derive(Copy, Clone, Debug)]
pub struct Material {
    pub color: Vec3,
    pub material_type: MaterialType,
    pub roughness: f32,
    pub emission: Vec3,
}

impl Material {
    pub fn diffuse(color: Vec3) -> Material {
        Material {
            color,
            material_type: MaterialType::Diffuse,
            roughness: 0.0,
            emission: Vec3::zero(),
        }
    }

    pub fn metal(color: Vec3, roughness: f32) -> Material {
        Material {
            color,
            material_type: MaterialType::Metal,
            roughness: roughness.clamp(0.0, 1.0),
            emission: Vec3::zero(),
        }
    }

    pub fn emissive(emission: Vec3) -> Material {
        Material {
            color: Vec3::one(),
            material_type: MaterialType::Emissive,
            roughness: 0.0,
            emission,
        }
    }

    pub fn is_emissive(&self) -> bool {
        matches!(self.material_type, MaterialType::Emissive)
    }

    pub fn emission(&self) -> Vec3 {
        self.emission
    }

    pub fn color(&self) -> Vec3 {
        self.color
    }

    pub fn scatter(&self, ray: &Ray, hit: &HitRecord) -> Ray {
        match self.material_type {
            MaterialType::Diffuse => {
                let direction = (hit.normal + Vec3::random_unit()).normalize();
                Ray::new(hit.point, direction)
            }
            MaterialType::Metal => {
                let reflected = ray.direction.reflect(&hit.normal);
                let fuzzed = reflected + Vec3::random_unit() * self.roughness;
                Ray::new(hit.point, fuzzed)
            }
            MaterialType::Emissive => {
                Ray::new(hit.point, ray.direction)
            }
        }
    }
}
