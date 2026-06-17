use crate::vec3::Vec3;
use crate::ray::Ray;
use crate::hittable::{HitRecord, Hittable};
use crate::material::Material;

#[derive(Copy, Clone, Debug)]
pub struct Plane {
    pub point: Vec3,
    pub normal: Vec3,
    pub material: Material,
}

impl Plane {
    pub fn new(point: Vec3, normal: Vec3, material: Material) -> Plane {
        Plane {
            point,
            normal: normal.normalize(),
            material,
        }
    }
}

impl Hittable for Plane {
    fn hit(&self, ray: &Ray, t_min: f32, t_max: f32) -> Option<HitRecord> {
        let denom = self.normal.dot(&ray.direction);
        
        if denom.abs() < 0.0001 {
            return None;
        }
        
        let t = (self.point - ray.origin).dot(&self.normal) / denom;
        
        if t < t_min || t > t_max {
            return None;
        }
        
        let point = ray.at(t);
        let mut normal = self.normal;
        
        if denom > 0.0 {
            normal = -normal;
        }
        
        Some(HitRecord {
            t,
            point,
            normal,
            material: self.material,
        })
    }
}
