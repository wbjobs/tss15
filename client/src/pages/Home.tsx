import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getSocket } from '../services/socket';
import '../styles/Home.css';

function Home() {
  const navigate = useNavigate();
  const goGallery = () => navigate('/gallery');
  const [roomCode, setRoomCode] = useState('');
  const [workerName, setWorkerName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [error, setError] = useState('');

  const handleCreateRoom = async () => {
    setIsCreating(true);
    setError('');

    const socket = getSocket();
    
    socket.emit('create-room', (response: any) => {
      setIsCreating(false);
      if (response.success) {
        navigate(`/scheduler/${response.roomId}`);
      } else {
        setError(response.error || 'Failed to create room');
      }
    });
  };

  const handleJoinAsWorker = async () => {
    if (!roomCode.trim()) {
      setError('Please enter a room code');
      return;
    }

    setIsJoining(true);
    setError('');

    const socket = getSocket();
    
    socket.emit('join-room', { 
      roomId: roomCode.trim(),
      workerName: workerName.trim() || undefined
    }, (response: any) => {
      setIsJoining(false);
      if (response.success) {
        navigate(`/worker/${roomCode.trim()}`);
      } else {
        setError(response.error || 'Failed to join room');
      }
    });
  };

  return (
    <div className="home-container">
      <div className="home-bg">
        <div className="bg-grid"></div>
        <div className="bg-glow glow-1"></div>
        <div className="bg-glow glow-2"></div>
      </div>

      <div className="home-content">
        <div className="hero-section">
          <div className="logo-container">
            <div className="logo-icon">
              <svg viewBox="0 0 64 64" fill="none">
                <circle cx="32" cy="32" r="28" stroke="url(#grad1)" strokeWidth="2" />
                <circle cx="32" cy="32" r="18" stroke="url(#grad2)" strokeWidth="2" opacity="0.6" />
                <circle cx="32" cy="32" r="8" fill="url(#grad3)" />
                <defs>
                  <linearGradient id="grad1" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#00d4ff" />
                    <stop offset="100%" stopColor="#7c5cff" />
                  </linearGradient>
                  <linearGradient id="grad2" x1="100%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stopColor="#7c5cff" />
                    <stop offset="100%" stopColor="#00e676" />
                  </linearGradient>
                  <radialGradient id="grad3">
                    <stop offset="0%" stopColor="#00d4ff" />
                    <stop offset="100%" stopColor="#7c5cff" />
                  </radialGradient>
                </defs>
              </svg>
            </div>
          </div>
          
          <h1 className="hero-title">
            <span className="title-gradient">分布式光线追踪</span>
          </h1>
          <p className="hero-subtitle">
            WebAssembly 驱动的浏览器端渲染农场调度器
          </p>
          
          <div className="feature-tags">
            <span className="tag">
              <span className="tag-dot tag-dot-cyan"></span>
              WebAssembly
            </span>
            <span className="tag">
              <span className="tag-dot tag-dot-purple"></span>
              WebRTC P2P
            </span>
            <span className="tag">
              <span className="tag-dot tag-dot-green"></span>
              路径追踪
            </span>
          </div>
        </div>

        <div className="mode-selector">
          <div className="mode-card mode-scheduler">
            <div className="mode-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
            </div>
            <h3>调度器模式</h3>
            <p>上传 GLTF 场景，管理 Worker 节点，查看实时渲染进度</p>
            <button 
              className="btn btn-primary"
              onClick={handleCreateRoom}
              disabled={isCreating}
            >
              {isCreating ? '创建中...' : '创建渲染房间'}
            </button>
          </div>

          <div className="mode-divider">
            <span>或</span>
          </div>

          <div className="mode-card mode-worker">
            <div className="mode-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </svg>
            </div>
            <h3>Worker 模式</h3>
            <p>加入房间，贡献算力，协助渲染瓦片任务</p>
            
            <div className="input-group">
              <input
                type="text"
                placeholder="房间代码"
                value={roomCode}
                onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
                className="input-room-code"
                maxLength={8}
              />
            </div>
            
            <div className="input-group">
              <input
                type="text"
                placeholder="Worker 名称（可选）"
                value={workerName}
                onChange={(e) => setWorkerName(e.target.value)}
                className="input-worker-name"
              />
            </div>

            <button 
              className="btn btn-secondary"
              onClick={handleJoinAsWorker}
              disabled={isJoining}
            >
              {isJoining ? '加入中...' : '加入作为 Worker'}
            </button>
          </div>
        </div>

        {error && (
          <div className="error-message">
            {error}
          </div>
        )}

        <div className="gallery-entry">
          <button className="btn-gallery" onClick={goGallery}>
            <span className="gallery-icon">🖼️</span>
            <span>历史渲染画廊</span>
            <span className="gallery-hint">查看和对比历史渲染任务</span>
          </button>
        </div>

        <div className="how-it-works">
          <h3>工作原理</h3>
          <div className="steps">
            <div className="step">
              <div className="step-number">1</div>
              <p>调度器上传场景，划分瓦片</p>
            </div>
            <div className="step">
              <div className="step-number">2</div>
              <p>WebRTC 连接 Worker 节点</p>
            </div>
            <div className="step">
              <div className="step-number">3</div>
              <p>分布式路径追踪渲染</p>
            </div>
            <div className="step">
              <div className="step-number">4</div>
              <p>收集结果，拼接成图</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Home;
