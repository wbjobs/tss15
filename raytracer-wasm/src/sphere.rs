use crate::vec3::Vec3;
use crate::ray::Ray;
use crate::hittable::{HitRecord, Hittable};
use crate::material::Material;

#[derive(Copy, Clone, Debug)]
pub struct Sphere {
    pub center: Vec3,
    pub radius: f32,
    pub material: Material,
}

impl Sphere {
    pub fn new(center: Vec3, radius: f32, material: Material) -> Sphere {
        Sphere {
            center,
            radius,
            material,
        }
    }
}

impl Hittable for Sphere {
    fn hit(&self, ray: &Ray, t_min: f32, t_max: f32) -> Option<HitRecord> {
        let oc = ray.origin - self.center;
        let a = ray.direction.length_squared();
        let half_b = oc.dot(&ray.direction);
        let c = oc.length_squared() - self.radius * self.radius;
        
        let discriminant = half_b * half_b - a * c;
        
        if discriminant < 0.0 {
            return None;
        }
        
        let sqrt_d = discriminant.sqrt();
        
        let mut t = (-half_b - sqrt_d) / a;
        if t < t_min || t > t_max {
            t = (-half_b + sqrt_d) / a;
            if t < t_min || t > t_max {
                return None;
            }
        }
        
        let point = ray.at(t);
        let normal = (point - self.center) / self.radius;
        
        Some(HitRecord {
            t,
            point,
            normal,
            material: self.material,
        })
    }
}
