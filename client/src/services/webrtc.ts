import { getSocket } from './socket';
import type { Tile, TileResult } from '../types';

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

export function sendTileResult(dataChannel: RTCDataChannel, result: TileResult): void {
  const message = {
    type: 'tile-result',
    result
  };
  const jsonStr = JSON.stringify({
    ...message,
    result: {
      ...result,
      pixelData: Array.from(result.pixelData)
    }
  });
  dataChannel.send(jsonStr);
}

export function sendProgressUpdate(dataChannel: RTCDataChannel, progress: number): void {
  const message = {
    type: 'progress',
    progress
  };
  dataChannel.send(JSON.stringify(message));
}
