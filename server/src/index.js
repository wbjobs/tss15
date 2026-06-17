import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
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

  socket.on('join-room', ({ roomId, workerName }, callback) => {
    const room = rooms.get(roomId);
    if (!room) {
      callback({ success: false, error: 'Room not found' });
      return;
    }

    const workerId = socket.id;
    const workerData = {
      id: workerId,
      name: workerName || `Worker-${workerId.slice(0, 4)}`,
      status: 'idle',
      joinedAt: Date.now().toString(),
      tilesRendered: '0',
      currentTile: ''
    };

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = 'worker';
    socket.data.workerData = workerData;

    addWorkerToRoom(roomId, workerData);
    room.workers.set(workerId, workerData);

    io.to(room.schedulerId).emit('worker-joined', workerData);
    
    console.log('Worker joined room:', roomId, 'worker:', workerId);
    callback({ success: true, workerId, roomId });
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
        currentTile: JSON.stringify(tile)
      });
    } catch {
      const room = rooms.get(roomId);
      if (room && room.workers.has(workerId)) {
        const worker = room.workers.get(workerId);
        worker.status = 'rendering';
        worker.currentTile = tile;
      }
    }
    callback?.({ success: true });
  });

  socket.on('tile-completed', ({ roomId, workerId, tile }, callback) => {
    try {
      redis.hincrby(getWorkerKey(roomId, workerId), 'tilesRendered', 1);
      redis.hset(getWorkerKey(roomId, workerId), {
        status: 'idle',
        currentTile: ''
      });
      redis.hincrby(getRoomKey(roomId), 'completedTiles', 1);
    } catch {
      const room = rooms.get(roomId);
      if (room && room.workers.has(workerId)) {
        const worker = room.workers.get(workerId);
        worker.status = 'idle';
        worker.currentTile = null;
        worker.tilesRendered = (parseInt(worker.tilesRendered || '0') + 1).toString();
      }
    }

    const room = rooms.get(roomId);
    if (room && room.schedulerId) {
      io.to(room.schedulerId).emit('tile-completed', { workerId, tile });
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
    const { roomId, role } = socket.data;
    if (!roomId) return;

    console.log('Client disconnected:', socket.id, 'role:', role);

    if (role === 'worker') {
      await removeWorkerFromRoom(roomId, socket.id);
      const room = rooms.get(roomId);
      if (room && room.schedulerId) {
        io.to(room.schedulerId).emit('worker-left', { workerId: socket.id });
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

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
  console.log(`Redis status: ${redis.status}`);
});
