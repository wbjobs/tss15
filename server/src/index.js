import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import {
  initGalleryStore,
  saveRenderTask,
  saveTileLog,
  saveTaskWorker,
  getRenderTasks,
  getRenderTaskById,
  getTaskImage,
  deleteRenderTask,
  isUsingPostgres
} from './galleryStore.js';

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  pingInterval: 5000,
  pingTimeout: 15000
});

app.use(cors());
app.use(express.json());

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379
});

redis.on('error', (err) => {
  console.warn('Redis connection failed, running in-memory mode:', err.message);
});

const rooms = new Map();
const workerReconnectTokens = new Map();

const getRoomKey = (roomId) => `room:${roomId}`;
const getWorkerKey = (roomId, workerId) => `room:${roomId}:worker:${workerId}`;

async function getRoomStats(roomId) {
  try {
    const roomData = await redis.hgetall(getRoomKey(roomId));
    const workers = [];
    const workerKeys = await redis.keys(`room:${roomId}:worker:*`);
    for (const key of workerKeys) {
      const workerData = await redis.hgetall(key);
      workers.push(workerData);
    }
    return { ...roomData, workers };
  } catch {
    const room = rooms.get(roomId);
    if (!room) return null;
    return {
      id: room.id,
      schedulerId: room.schedulerId,
      workerCount: room.workers.size,
      workers: Array.from(room.workers.values())
    };
  }
}

async function updateRoomStats(roomId, updates) {
  try {
    await redis.hset(getRoomKey(roomId), updates);
  } catch {
    const room = rooms.get(roomId);
    if (room) {
      Object.assign(room, updates);
    }
  }
}

async function addWorkerToRoom(roomId, workerData) {
  try {
    await redis.hset(getWorkerKey(roomId, workerData.id), workerData);
    const room = await redis.hgetall(getRoomKey(roomId));
    const workerCount = parseInt(room.workerCount || '0') + 1;
    await redis.hset(getRoomKey(roomId), { workerCount });
  } catch {
    const room = rooms.get(roomId);
    if (room) {
      room.workers.set(workerData.id, workerData);
    }
  }
}

async function removeWorkerFromRoom(roomId, workerId) {
  try {
    await redis.del(getWorkerKey(roomId, workerId));
    const room = await redis.hgetall(getRoomKey(roomId));
    const workerCount = Math.max(0, parseInt(room.workerCount || '0') - 1);
    await redis.hset(getRoomKey(roomId), { workerCount });
  } catch {
    const room = rooms.get(roomId);
    if (room) {
      room.workers.delete(workerId);
    }
  }
}

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      schedulerId: null,
      workers: new Map(),
      sceneData: null
    });
  }
  return rooms.get(roomId);
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('create-room', (callback) => {
    const roomId = uuidv4().slice(0, 8);
    getOrCreateRoom(roomId);
    const room = rooms.get(roomId);
    room.schedulerId = socket.id;
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = 'scheduler';
    
    updateRoomStats(roomId, {
      id: roomId,
      schedulerId: socket.id,
      workerCount: 0,
      status: 'waiting',
      createdAt: Date.now().toString()
    });

    console.log('Room created:', roomId, 'by scheduler:', socket.id);
    callback({ success: true, roomId });
  });

  socket.on('join-room', ({ roomId, workerName, reconnectToken }, callback) => {
    const room = rooms.get(roomId);
    if (!room) {
      callback({ success: false, error: 'Room not found' });
      return;
    }

    if (reconnectToken && workerReconnectTokens.has(reconnectToken)) {
      const oldWorkerId = workerReconnectTokens.get(reconnectToken);
      const oldWorker = room.workers.get(oldWorkerId);
      
      if (oldWorker) {
        const newWorkerId = socket.id;
        const newWorkerData = {
          ...oldWorker,
          id: newWorkerId,
          status: 'idle',
          lastHeartbeat: Date.now().toString()
        };

        room.workers.delete(oldWorkerId);
        room.workers.set(newWorkerId, newWorkerData);
        
        socket.join(roomId);
        socket.data.roomId = roomId;
        socket.data.role = 'worker';
        socket.data.workerData = newWorkerData;
        socket.data.previousWorkerId = oldWorkerId;

        addWorkerToRoom(roomId, newWorkerData);
        workerReconnectTokens.delete(reconnectToken);

        if (room.schedulerId) {
          io.to(room.schedulerId).emit('worker-reconnected', {
            oldWorkerId,
            newWorkerId,
            workerName: newWorkerData.name,
            hadActiveTile: oldWorker.currentTile !== null && oldWorker.currentTile !== ''
          });
        }

        console.log('Worker reconnected:', oldWorkerId, '->', newWorkerId);
        callback({ 
          success: true, 
          workerId: newWorkerId, 
          roomId,
          isReconnect: true,
          previousTile: oldWorker.currentTile || null
        });
        return;
      }
    }

    const workerId = socket.id;
    const newReconnectToken = uuidv4();
    const workerData = {
      id: workerId,
      name: workerName || `Worker-${workerId.slice(0, 4)}`,
      status: 'idle',
      joinedAt: Date.now().toString(),
      lastHeartbeat: Date.now().toString(),
      tilesRendered: '0',
      currentTile: '',
      avgRenderTime: '0',
      timeoutCount: '0',
      reconnectToken: newReconnectToken
    };

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = 'worker';
    socket.data.workerData = workerData;

    addWorkerToRoom(roomId, workerData);
    room.workers.set(workerId, workerData);
    workerReconnectTokens.set(newReconnectToken, workerId);

    io.to(room.schedulerId).emit('worker-joined', workerData);
    
    console.log('Worker joined room:', roomId, 'worker:', workerId);
    callback({ success: true, workerId, roomId, reconnectToken: newReconnectToken });
  });

  socket.on('worker-heartbeat', ({ roomId, workerId, progress }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    if (room.workers.has(workerId)) {
      const worker = room.workers.get(workerId);
      worker.lastHeartbeat = Date.now().toString();
      if (progress !== undefined) {
        worker.progress = progress.toString();
      }
    }

    if (room.schedulerId) {
      io.to(room.schedulerId).emit('worker-heartbeat', {
        workerId,
        timestamp: Date.now(),
        progress
      });
    }
  });

  socket.on('scene-uploaded', ({ roomId, sceneData }, callback) => {
    const room = rooms.get(roomId);
    if (!room) {
      callback({ success: false, error: 'Room not found' });
      return;
    }

    room.sceneData = sceneData;
    updateRoomStats(roomId, { status: 'ready' });

    io.to(roomId).emit('scene-ready', { sceneData });
    
    console.log('Scene uploaded to room:', roomId);
    callback({ success: true });
  });

  socket.on('start-render', ({ roomId, params }, callback) => {
    const room = rooms.get(roomId);
    if (!room) {
      callback({ success: false, error: 'Room not found' });
      return;
    }

    updateRoomStats(roomId, { 
      status: 'rendering',
      totalTiles: params.totalTiles?.toString() || '0',
      completedTiles: '0'
    });

    io.to(roomId).emit('render-started', { params });
    console.log('Render started in room:', roomId);
    callback({ success: true });
  });

  socket.on('tile-assigned', ({ roomId, workerId, tile }, callback) => {
    try {
      redis.hset(getWorkerKey(roomId, workerId), {
        status: 'rendering',
        currentTile: JSON.stringify(tile),
        assignedAt: Date.now().toString()
      });
    } catch {
      const room = rooms.get(roomId);
      if (room && room.workers.has(workerId)) {
        const worker = room.workers.get(workerId);
        worker.status = 'rendering';
        worker.currentTile = tile;
        worker.assignedAt = Date.now().toString();
      }
    }
    callback?.({ success: true });
  });

  socket.on('tile-completed', ({ roomId, workerId, tile, renderTime }, callback) => {
    try {
      redis.hincrby(getWorkerKey(roomId, workerId), 'tilesRendered', 1);
      redis.hset(getWorkerKey(roomId, workerId), {
        status: 'idle',
        currentTile: ''
      });
      redis.hincrby(getRoomKey(roomId), 'completedTiles', 1);
      if (renderTime) {
        const workerData = redis.hgetall(getWorkerKey(roomId, workerId));
        const oldAvg = parseFloat(workerData.avgRenderTime || '0');
        const newAvg = oldAvg === 0 ? renderTime : (oldAvg * 0.7 + renderTime * 0.3);
        redis.hset(getWorkerKey(roomId, workerId), { avgRenderTime: newAvg.toString() });
      }
    } catch {
      const room = rooms.get(roomId);
      if (room && room.workers.has(workerId)) {
        const worker = room.workers.get(workerId);
        worker.status = 'idle';
        worker.currentTile = null;
        worker.tilesRendered = (parseInt(worker.tilesRendered || '0') + 1).toString();
        if (renderTime) {
          const oldAvg = parseFloat(worker.avgRenderTime || '0');
          worker.avgRenderTime = (oldAvg === 0 ? renderTime : (oldAvg * 0.7 + renderTime * 0.3)).toString();
        }
      }
    }

    const room = rooms.get(roomId);
    if (room && room.schedulerId) {
      io.to(room.schedulerId).emit('tile-completed', { workerId, tile, renderTime });
    }

    callback?.({ success: true });
  });

  socket.on('worker-progress', ({ roomId, workerId, progress }) => {
    try {
      redis.hset(getWorkerKey(roomId, workerId), { progress: progress.toString() });
    } catch {
      const room = rooms.get(roomId);
      if (room && room.workers.has(workerId)) {
        room.workers.get(workerId).progress = progress;
      }
    }

    const room = rooms.get(roomId);
    if (room && room.schedulerId) {
      io.to(room.schedulerId).emit('worker-progress', { workerId, progress });
    }
  });

  socket.on('tile-reassigned', ({ roomId, tileId, fromWorkerId, toWorkerId, reason }, callback) => {
    console.log('Tile reassigned:', tileId, 'from', fromWorkerId, 'to', toWorkerId, 'reason:', reason);
    callback?.({ success: true });
  });

  socket.on('offer', ({ to, offer }) => {
    io.to(to).emit('offer', { from: socket.id, offer });
  });

  socket.on('answer', ({ to, answer }) => {
    io.to(to).emit('answer', { from: socket.id, answer });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  socket.on('disconnect', async () => {
    const { roomId, role, workerData } = socket.data;
    if (!roomId) return;

    console.log('Client disconnected:', socket.id, 'role:', role);

    if (role === 'worker') {
      const room = rooms.get(roomId);
      if (room && room.workers.has(socket.id)) {
        const worker = room.workers.get(socket.id);
        worker.status = 'disconnected';
        worker.disconnectedAt = Date.now().toString();
        
        if (worker.reconnectToken) {
          workerReconnectTokens.set(worker.reconnectToken, socket.id);
        }
      }

      if (room && room.schedulerId) {
        const worker = room.workers.get(socket.id);
        io.to(room.schedulerId).emit('worker-left', { 
          workerId: socket.id,
          hadActiveTile: worker?.currentTile !== null && worker?.currentTile !== '',
          reconnectToken: worker?.reconnectToken
        });
      }
    } else if (role === 'scheduler') {
      const room = rooms.get(roomId);
      if (room) {
        io.to(roomId).emit('scheduler-left');
      }
    }
  });

  socket.on('get-room-stats', async ({ roomId }, callback) => {
    const stats = await getRoomStats(roomId);
    callback({ success: true, stats });
  });
});

app.get('/api/rooms/:roomId', async (req, res) => {
  const stats = await getRoomStats(req.params.roomId);
  if (!stats) {
    res.status(404).json({ error: 'Room not found' });
    return;
  }
  res.json(stats);
});

app.get('/api/rooms/:roomId/workers', async (req, res) => {
  try {
    const workerKeys = await redis.keys(`room:${req.params.roomId}:worker:*`);
    const workers = [];
    for (const key of workerKeys) {
      const workerData = await redis.hgetall(key);
      workers.push(workerData);
    }
    res.json(workers);
  } catch {
    const room = rooms.get(req.params.roomId);
    if (!room) {
      res.status(404).json({ error: 'Room not found' });
      return;
    }
    res.json(Array.from(room.workers.values()));
  }
});

app.get('/api/gallery/tasks', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const tasks = await getRenderTasks(limit, offset);
    res.json({ success: true, tasks, usingPostgres: isUsingPostgres() });
  } catch (error) {
    console.error('Failed to get gallery tasks:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/gallery/tasks/:taskId', async (req, res) => {
  try {
    const task = await getRenderTaskById(req.params.taskId);
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }
    res.json({ success: true, task });
  } catch (error) {
    console.error('Failed to get gallery task:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/gallery/tasks/:taskId/image', async (req, res) => {
  try {
    const imageData = await getTaskImage(req.params.taskId);
    if (!imageData) {
      res.status(404).json({ success: false, error: 'Image not found' });
      return;
    }
    const imgBuffer = Buffer.from(imageData, 'base64');
    res.setHeader('Content-Type', 'image/png');
    res.send(imgBuffer);
  } catch (error) {
    console.error('Failed to get task image:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/gallery/tasks', express.json({ limit: '50mb' }), async (req, res) => {
  try {
    const taskData = req.body;
    if (!taskData.width || !taskData.height || !taskData.samplesPerPixel) {
      res.status(400).json({ success: false, error: 'Missing required fields' });
      return;
    }

    let imageBuffer = null;
    if (taskData.imageData) {
      if (typeof taskData.imageData === 'string') {
        imageBuffer = Buffer.from(taskData.imageData, 'base64');
      } else {
        imageBuffer = Buffer.from(taskData.imageData);
      }
    }

    const taskId = await saveRenderTask({
      ...taskData,
      imageData: imageBuffer
    });

    if (taskData.tileLogs && Array.isArray(taskData.tileLogs)) {
      for (const log of taskData.tileLogs.slice(0, 500)) {
        await saveTileLog(taskId, log);
      }
    }

    if (taskData.workers && Array.isArray(taskData.workers)) {
      for (const worker of taskData.workers) {
        await saveTaskWorker(taskId, worker);
      }
    }

    res.json({ success: true, taskId });
  } catch (error) {
    console.error('Failed to save gallery task:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/gallery/tasks/:taskId', async (req, res) => {
  try {
    const result = await deleteRenderTask(req.params.taskId);
    if (!result) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete gallery task:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, async () => {
  console.log(`Signaling server running on port ${PORT}`);
  console.log(`Redis status: ${redis.status}`);
  await initGalleryStore();
  console.log(`Gallery storage: ${isUsingPostgres() ? 'PostgreSQL' : 'In-Memory'}`);
});
