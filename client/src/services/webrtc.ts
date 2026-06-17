import { getSocket } from './socket';
import type { Tile, TileResult, WorkerResumeState, IncrementalTileTask, IncrementalTileResult, TileOverlap } from '../types';

export interface PeerConnectionOptions {
  onOpen?: () => void;
  onMessage?: (message: any) => void;
  onClose?: () => void;
  onError?: (error: Error) => void;
}

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};

export function createPeerConnection(): RTCPeerConnection {
  return new RTCPeerConnection(RTC_CONFIG);
}

export function setupDataChannel(
  pc: RTCPeerConnection,
  channelLabel: string,
  options: PeerConnectionOptions = {}
): RTCDataChannel {
  const dataChannel = pc.createDataChannel(channelLabel, {
    ordered: true
  });

  dataChannel.onopen = () => {
    console.log(`Data channel ${channelLabel} opened`);
    options.onOpen?.();
  };

  dataChannel.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      options.onMessage?.(message);
    } catch (e) {
      options.onMessage?.(event.data);
    }
  };

  dataChannel.onclose = () => {
    console.log(`Data channel ${channelLabel} closed`);
    options.onClose?.();
  };

  dataChannel.onerror = (error) => {
    console.error(`Data channel ${channelLabel} error:`, error);
    options.onError?.(error as Error);
  };

  return dataChannel;
}

export async function createOffer(pc: RTCPeerConnection): Promise<RTCSessionDescriptionInit> {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  return offer;
}

export async function handleOffer(
  pc: RTCPeerConnection,
  offer: RTCSessionDescriptionInit
): Promise<RTCSessionDescriptionInit> {
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  return answer;
}

export async function handleAnswer(
  pc: RTCPeerConnection,
  answer: RTCSessionDescriptionInit
): Promise<void> {
  await pc.setRemoteDescription(new RTCSessionDescription(answer));
}

export function addIceCandidate(pc: RTCPeerConnection, candidate: RTCIceCandidateInit): void {
  pc.addIceCandidate(new RTCIceCandidate(candidate));
}

export function setupIceCandidateExchange(
  pc: RTCPeerConnection,
  remoteSocketId: string
): void {
  const socket = getSocket();

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', {
        to: remoteSocketId,
        candidate: event.candidate.toJSON()
      });
    }
  };
}

export function sendTileTask(dataChannel: RTCDataChannel, tile: Tile, sceneData: any): void {
  const message = {
    type: 'tile-task',
    tile,
    sceneData
  };
  dataChannel.send(JSON.stringify(message));
}

export function sendTileResult(dataChannel: RTCDataChannel, result: any): void {
  const message = {
    type: 'tile-result',
    result: {
      ...result,
      pixelData: Array.from(result.pixelData)
    }
  };
  dataChannel.send(JSON.stringify(message));
}

export function sendProgressUpdate(dataChannel: RTCDataChannel, progress: number): void {
  const message = {
    type: 'progress',
    progress
  };
  dataChannel.send(JSON.stringify(message));
}

export function sendHeartbeat(dataChannel: RTCDataChannel): void {
  const message = {
    type: 'heartbeat',
    timestamp: Date.now()
  };
  if (dataChannel.readyState === 'open') {
    dataChannel.send(JSON.stringify(message));
  }
}

export function sendHeartbeatAck(dataChannel: RTCDataChannel, originalTimestamp: number): void {
  const message = {
    type: 'heartbeat-ack',
    originalTimestamp,
    timestamp: Date.now()
  };
  if (dataChannel.readyState === 'open') {
    dataChannel.send(JSON.stringify(message));
  }
}

export function sendResumeState(dataChannel: RTCDataChannel, resumeState: WorkerResumeState): void {
  const message = {
    type: 'resume-state',
    resumeState: {
      ...resumeState,
      partialPixelData: resumeState.partialPixelData
        ? Array.from(resumeState.partialPixelData)
        : null
    }
  };
  if (dataChannel.readyState === 'open') {
    dataChannel.send(JSON.stringify(message));
  }
}

export function sendCancelTile(dataChannel: RTCDataChannel, tileId: string, reason: string): void {
  const message = {
    type: 'cancel-tile',
    tileId,
    reason
  };
  if (dataChannel.readyState === 'open') {
    dataChannel.send(JSON.stringify(message));
  }
}

export class HeartbeatManager {
  private intervalId: number | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private onTimeout: (() => void) | null = null;
  private onHeartbeat: ((latency: number) => void) | null = null;
  private lastHeartbeatSent: number = 0;
  private missedHeartbeats: number = 0;
  private readonly maxMissedHeartbeats: number = 3;

  start(
    dataChannel: RTCDataChannel,
    intervalMs: number,
    callbacks: {
      onTimeout?: () => void;
      onHeartbeat?: (latency: number) => void;
    } = {}
  ): void {
    this.stop();
    this.dataChannel = dataChannel;
    this.onTimeout = callbacks.onTimeout || null;
    this.onHeartbeat = callbacks.onHeartbeat || null;
    this.missedHeartbeats = 0;

    this.intervalId = window.setInterval(() => {
      if (dataChannel.readyState === 'open') {
        this.lastHeartbeatSent = Date.now();
        this.missedHeartbeats++;

        if (this.missedHeartbeats > this.maxMissedHeartbeats) {
          console.warn('Heartbeat timeout: too many missed heartbeats');
          this.onTimeout?.();
          this.stop();
          return;
        }

        sendHeartbeat(dataChannel);
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  handleHeartbeatAck(): void {
    this.missedHeartbeats = 0;
    const latency = Date.now() - this.lastHeartbeatSent;
    this.onHeartbeat?.(latency);
  }

  getLatency(): number {
    return this.missedHeartbeats === 0 && this.lastHeartbeatSent > 0
      ? Date.now() - this.lastHeartbeatSent
      : -1;
  }
}

export function sendIncrementalTileTask(
  dataChannel: RTCDataChannel,
  task: IncrementalTileTask
): void {
  const message = {
    type: 'incremental-tile-task',
    tile: task.tile,
    sceneData: task.sceneData,
    startSample: task.startSample,
    endSample: task.endSample,
    batchId: task.batchId
  };
  if (dataChannel.readyState === 'open') {
    dataChannel.send(JSON.stringify(message));
  }
}

export function sendIncrementalTileResult(
  dataChannel: RTCDataChannel,
  result: IncrementalTileResult & { overlap: TileOverlap }
): void {
  const message = {
    type: 'incremental-tile-result',
    result: {
      ...result,
      accumulatedColor: Array.from(result.accumulatedColor)
    }
  };
  if (dataChannel.readyState === 'open') {
    dataChannel.send(JSON.stringify(message));
  }
}
