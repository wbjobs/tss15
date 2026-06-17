use crate::vec3::Vec3;
use crate::ray::Ray;

pub struct Camera {
    pub position: Vec3,
    pub target: Vec3,
    pub fov: f32,
    pub aspect_ratio: f32,
    
    lower_left_corner: Vec3,
    horizontal: Vec3,
    vertical: Vec3,
}

impl Camera {
    pub fn new(position: Vec3, target: Vec3, fov: f32, aspect_ratio: f32) -> Camera {
        let fov_rad = fov * std::f32::consts::PI / 180.0;
        let viewport_height = 2.0 * (fov_rad / 2.0).tan();
        let viewport_width = viewport_height * aspect_ratio;
        
        let w = (position - target).normalize();
        let up = Vec3::new(0.0, 1.0, 0.0);
        let u = up.cross(&w).normalize();
        let v = w.cross(&u);
        
        let horizontal = u * viewport_width;
        let vertical = v * viewport_height;
        let lower_left_corner = position - horizontal / 2.0 - vertical / 2.0 - w;
        
        Camera {
            position,
            target,
            fov,
            aspect_ratio,
            lower_left_corner,
            horizontal,
            vertical,
        }
    }

    pub fn get_ray(&self, u: f32, v: f32) -> Ray {
        let direction = self.lower_left_corner + self.horizontal * u + self.vertical * v - self.position;
        Ray::new(self.position, direction)
    }
}
