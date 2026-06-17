import pkg from 'pg';
const { Pool } = pkg;
import { v4 as uuidv4 } from 'uuid';

const PG_CONFIG = {
  host: process.env.PGHOST || 'localhost',
  port: process.env.PGPORT || 5432,
  database: process.env.PGDATABASE || 'raytracer_gallery',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000
};

let pool = null;
let usePostgres = false;
const inMemoryStore = {
  tasks: [],
  tileLogs: [],
  workers: []
};

async function initGalleryStore() {
  try {
    pool = new Pool(PG_CONFIG);
    await pool.query('SELECT 1');
    usePostgres = true;
    console.log('✅ PostgreSQL connected successfully');
    await initTables();
  } catch (error) {
    console.warn('⚠️ PostgreSQL connection failed, using in-memory store:', error.message);
    usePostgres = false;
    pool = null;
  }
}

async function initTables() {
  if (!usePostgres) return;
  
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS render_tasks (
        id UUID PRIMARY KEY,
        room_id VARCHAR(255) NOT NULL,
        scene_name VARCHAR(255),
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        samples_per_pixel INTEGER NOT NULL,
        tile_size INTEGER NOT NULL,
        overlap_size INTEGER NOT NULL,
        total_tiles INTEGER NOT NULL,
        total_workers INTEGER NOT NULL,
        total_render_time_ms BIGINT DEFAULT 0,
        image_data BYTEA,
        status VARCHAR(50) DEFAULT 'completed',
        light_intensity REAL DEFAULT 1.0,
        params JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS tile_progress_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        task_id UUID REFERENCES render_tasks(id) ON DELETE CASCADE,
        tile_id VARCHAR(255) NOT NULL,
        worker_id VARCHAR(255) NOT NULL,
        worker_name VARCHAR(255),
        batch_id VARCHAR(255),
        sample_start INTEGER,
        sample_end INTEGER,
        samples_rendered INTEGER,
        render_time_ms INTEGER,
        tile_index INTEGER,
        tile_x INTEGER,
        tile_y INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS task_workers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        task_id UUID REFERENCES render_tasks(id) ON DELETE CASCADE,
        worker_id VARCHAR(255) NOT NULL,
        worker_name VARCHAR(255),
        tiles_rendered INTEGER DEFAULT 0,
        avg_render_time_ms INTEGER DEFAULT 0,
        total_render_time_ms BIGINT DEFAULT 0
      )
    `);

    console.log('✅ Gallery tables initialized');
  } catch (error) {
    console.error('Failed to initialize gallery tables:', error);
  }
}

async function saveRenderTask(taskData) {
  const taskId = taskData.id || uuidv4();
  
  if (usePostgres && pool) {
    try {
      const result = await pool.query(`
        INSERT INTO render_tasks (
          id, room_id, scene_name, width, height, samples_per_pixel,
          tile_size, overlap_size, total_tiles, total_workers,
          total_render_time_ms, image_data, status, light_intensity,
          params, created_at, completed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        RETURNING id
      `, [
        taskId,
        taskData.roomId,
        taskData.sceneName || 'Untitled',
        taskData.width,
        taskData.height,
        taskData.samplesPerPixel,
        taskData.tileSize,
        taskData.overlapSize,
        taskData.totalTiles,
        taskData.totalWorkers || 0,
        taskData.totalRenderTimeMs || 0,
        taskData.imageData || null,
        taskData.status || 'completed',
        taskData.lightIntensity || 1.0,
        JSON.stringify(taskData.params || {}),
        taskData.createdAt || new Date(),
        taskData.completedAt || new Date()
      ]);
      return result.rows[0].id;
    } catch (error) {
      console.error('Failed to save render task to PG:', error);
    }
  }

  const task = {
    id: taskId,
    roomId: taskData.roomId,
    sceneName: taskData.sceneName || 'Untitled',
    width: taskData.width,
    height: taskData.height,
    samplesPerPixel: taskData.samplesPerPixel,
    tileSize: taskData.tileSize,
    overlapSize: taskData.overlapSize,
    totalTiles: taskData.totalTiles,
    totalWorkers: taskData.totalWorkers || 0,
    totalRenderTimeMs: taskData.totalRenderTimeMs || 0,
    imageData: taskData.imageData || null,
    status: taskData.status || 'completed',
    lightIntensity: taskData.lightIntensity || 1.0,
    params: taskData.params || {},
    createdAt: taskData.createdAt || new Date(),
    completedAt: taskData.completedAt || new Date(),
    tileLogs: [],
    workers: []
  };
  
  inMemoryStore.tasks.unshift(task);
  if (inMemoryStore.tasks.length > 100) {
    inMemoryStore.tasks = inMemoryStore.tasks.slice(0, 100);
  }
  
  return taskId;
}

async function saveTileLog(taskId, logData) {
  if (usePostgres && pool) {
    try {
      await pool.query(`
        INSERT INTO tile_progress_logs (
          task_id, tile_id, worker_id, worker_name, batch_id,
          sample_start, sample_end, samples_rendered, render_time_ms,
          tile_index, tile_x, tile_y
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `, [
        taskId,
        logData.tileId,
        logData.workerId,
        logData.workerName || '',
        logData.batchId || null,
        logData.sampleStart || 0,
        logData.sampleEnd || 0,
        logData.samplesRendered || 0,
        logData.renderTimeMs || 0,
        logData.tileIndex || 0,
        logData.tileX || 0,
        logData.tileY || 0
      ]);
      return true;
    } catch (error) {
      console.error('Failed to save tile log to PG:', error);
      return false;
    }
  }

  const task = inMemoryStore.tasks.find(t => t.id === taskId);
  if (task) {
    task.tileLogs.push({
      ...logData,
      createdAt: new Date()
    });
  }
  return true;
}

async function saveTaskWorker(taskId, workerData) {
  if (usePostgres && pool) {
    try {
      await pool.query(`
        INSERT INTO task_workers (
          task_id, worker_id, worker_name, tiles_rendered,
          avg_render_time_ms, total_render_time_ms
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        taskId,
        workerData.workerId,
        workerData.workerName || '',
        workerData.tilesRendered || 0,
        workerData.avgRenderTimeMs || 0,
        workerData.totalRenderTimeMs || 0
      ]);
      return true;
    } catch (error) {
      console.error('Failed to save task worker to PG:', error);
      return false;
    }
  }

  const task = inMemoryStore.tasks.find(t => t.id === taskId);
  if (task) {
    task.workers.push(workerData);
  }
  return true;
}

async function getRenderTasks(limit = 50, offset = 0) {
  if (usePostgres && pool) {
    try {
      const result = await pool.query(`
        SELECT id, room_id as "roomId", scene_name as "sceneName",
          width, height, samples_per_pixel as "samplesPerPixel",
          tile_size as "tileSize", overlap_size as "overlapSize",
          total_tiles as "totalTiles", total_workers as "totalWorkers",
          total_render_time_ms as "totalRenderTimeMs",
          status, light_intensity as "lightIntensity",
          params, created_at as "createdAt", completed_at as "completedAt"
        FROM render_tasks
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2
      `, [limit, offset]);
      
      const tasks = result.rows.map(row => ({
        ...row,
        params: row.params || {},
        hasImage: !!row.imageData
      }));
      
      return tasks;
    } catch (error) {
      console.error('Failed to get render tasks from PG:', error);
      return [];
    }
  }

  return inMemoryStore.tasks.slice(offset, offset + limit).map(task => ({
    id: task.id,
    roomId: task.roomId,
    sceneName: task.sceneName,
    width: task.width,
    height: task.height,
    samplesPerPixel: task.samplesPerPixel,
    tileSize: task.tileSize,
    overlapSize: task.overlapSize,
    totalTiles: task.totalTiles,
    totalWorkers: task.totalWorkers,
    totalRenderTimeMs: task.totalRenderTimeMs,
    status: task.status,
    lightIntensity: task.lightIntensity,
    params: task.params,
    createdAt: task.createdAt,
    completedAt: task.completedAt,
    hasImage: !!task.imageData
  }));
}

async function getRenderTaskById(taskId) {
  if (usePostgres && pool) {
    try {
      const taskResult = await pool.query(`
        SELECT id, room_id as "roomId", scene_name as "sceneName",
          width, height, samples_per_pixel as "samplesPerPixel",
          tile_size as "tileSize", overlap_size as "overlapSize",
          total_tiles as "totalTiles", total_workers as "totalWorkers",
          total_render_time_ms as "totalRenderTimeMs",
          image_data as "imageData",
          status, light_intensity as "lightIntensity",
          params, created_at as "createdAt", completed_at as "completedAt"
        FROM render_tasks
        WHERE id = $1
      `, [taskId]);

      if (taskResult.rows.length === 0) return null;

      const logsResult = await pool.query(`
        SELECT tile_id as "tileId", worker_id as "workerId",
          worker_name as "workerName", batch_id as "batchId",
          sample_start as "sampleStart", sample_end as "sampleEnd",
          samples_rendered as "samplesRendered",
          render_time_ms as "renderTimeMs",
          tile_index as "tileIndex", tile_x as "tileX", tile_y as "tileY",
          created_at as "createdAt"
        FROM tile_progress_logs
        WHERE task_id = $1
        ORDER BY created_at DESC
      `, [taskId]);

      const workersResult = await pool.query(`
        SELECT worker_id as "workerId", worker_name as "workerName",
          tiles_rendered as "tilesRendered",
          avg_render_time_ms as "avgRenderTimeMs",
          total_render_time_ms as "totalRenderTimeMs"
        FROM task_workers
        WHERE task_id = $1
      `, [taskId]);

      const task = taskResult.rows[0];
      return {
        ...task,
        params: task.params || {},
        tileLogs: logsResult.rows,
        workers: workersResult.rows,
        imageData: task.imageData ? task.imageData.toString('base64') : null
      };
    } catch (error) {
      console.error('Failed to get render task by id from PG:', error);
      return null;
    }
  }

  const task = inMemoryStore.tasks.find(t => t.id === taskId);
  if (!task) return null;

  return {
    ...task,
    tileLogs: task.tileLogs || [],
    workers: task.workers || [],
    imageData: task.imageData ? Buffer.from(task.imageData).toString('base64') : null
  };
}

async function getTaskImage(taskId) {
  if (usePostgres && pool) {
    try {
      const result = await pool.query(`
        SELECT image_data as "imageData"
        FROM render_tasks
        WHERE id = $1
      `, [taskId]);

      if (result.rows.length === 0 || !result.rows[0].imageData) return null;
      return result.rows[0].imageData.toString('base64');
    } catch (error) {
      console.error('Failed to get task image from PG:', error);
      return null;
    }
  }

  const task = inMemoryStore.tasks.find(t => t.id === taskId);
  if (!task || !task.imageData) return null;
  return Buffer.from(task.imageData).toString('base64');
}

async function deleteRenderTask(taskId) {
  if (usePostgres && pool) {
    try {
      await pool.query('DELETE FROM render_tasks WHERE id = $1', [taskId]);
      return true;
    } catch (error) {
      console.error('Failed to delete render task from PG:', error);
      return false;
    }
  }

  const index = inMemoryStore.tasks.findIndex(t => t.id === taskId);
  if (index !== -1) {
    inMemoryStore.tasks.splice(index, 1);
    return true;
  }
  return false;
}

function isUsingPostgres() {
  return usePostgres;
}

export {
  initGalleryStore,
  saveRenderTask,
  saveTileLog,
  saveTaskWorker,
  getRenderTasks,
  getRenderTaskById,
  getTaskImage,
  deleteRenderTask,
  isUsingPostgres
};
