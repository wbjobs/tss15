use crate::vec3::Vec3;
use crate::ray::Ray;
use crate::hittable::{HitRecord, Hittable};
use crate::sphere::Sphere;
use crate::plane::Plane;
use crate::material::Material;

pub struct Scene {
    spheres: Vec<Sphere>,
    planes: Vec<Plane>,
}

impl Scene {
    pub fn new() -> Scene {
        Scene {
            spheres: Vec::new(),
            planes: Vec::new(),
        }
    }

    pub fn add_sphere(&mut self, center: Vec3, radius: f32, material: Material) {
        self.spheres.push(Sphere::new(center, radius, material));
    }

    pub fn add_plane(&mut self, point: Vec3, normal: Vec3, material: Material) {
        self.planes.push(Plane::new(point, normal, material));
    }

    pub fn hit(&self, ray: &Ray, t_min: f32, t_max: f32) -> Option<HitRecord> {
        let mut closest: Option<HitRecord> = None;
        let mut closest_t = t_max;

        for sphere in &self.spheres {
            if let Some(hit) = sphere.hit(ray, t_min, closest_t) {
                closest_t = hit.t;
                closest = Some(hit);
            }
        }

        for plane in &self.planes {
            if let Some(hit) = plane.hit(ray, t_min, closest_t) {
                closest_t = hit.t;
                closest = Some(hit);
            }
        }

        closest
    }
}
