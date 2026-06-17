use crate::vec3::Vec3;
use crate::ray::Ray;
use crate::material::Material;

#[derive(Copy, Clone, Debug)]
pub struct HitRecord {
    pub t: f32,
    pub point: Vec3,
    pub normal: Vec3,
    pub material: Material,
}

pub trait Hittable {
    fn hit(&self, ray: &Ray, t_min: f32, t_max: f32) -> Option<HitRecord>;
}
