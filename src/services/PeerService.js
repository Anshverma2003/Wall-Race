import { EventEmitter } from '../core/EventEmitter.js';
import { NETWORK, ROOM } from '../config.js';

const PING = '__ping';

/**
 * Wraps PeerJS (WebRTC data channels).
 *
 *  - Host:  opens a Peer whose id is derived from the room code, accepts connections.
 *  - Guest: opens an anonymous Peer and connects to the host's id.
 *
 * Adds an application-level heartbeat because a closed browser tab does not
 * always fire a `close` event on the remote side.
 *
 * Events:
 *  'connection' (connId)        – a remote peer opened a data channel (host only)
 *  'message'    (connId, data)  – a JSON message arrived
 *  'disconnect' (connId)        – a data channel closed or timed out
 *  'error'      (Error)         – fatal peer error after setup
 */
export class PeerService extends EventEmitter {
  /** @type {import('peerjs').Peer | null} */
  #peer = null;
  /** @type {Map<string, {conn: any, lastSeen: number}>} */
  #conns = new Map();
  #heartbeat = null;

  static get isSupported() {
    return typeof window.Peer === 'function';
  }

  static peerIdFor(code) {
    return ROOM.PEER_PREFIX + code;
  }

  get isActive() {
    return !!this.#peer && !this.#peer.destroyed;
  }

  /**
   * Registers this browser as the room host.
   * Rejects with err.type === 'unavailable-id' if the code is already taken.
   */
  host(code) {
    this.destroy();
    return new Promise((resolve, reject) => {
      const peer = new window.Peer(PeerService.peerIdFor(code), NETWORK.PEER_OPTIONS);
      this.#peer = peer;
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.destroy();
        reject(Object.assign(new Error('Timed out contacting the signalling server.'), { type: 'timeout' }));
      }, NETWORK.CONNECT_TIMEOUT_MS);

      peer.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#startHeartbeat();
        resolve();
      });

      peer.on('connection', (conn) => this.#bindConnection(conn, true));
      this.#bindPeerLifecycle(peer, (err) => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        this.destroy();
        reject(err);
        return true;
      });
    });
  }

  /**
   * Connects to an existing room.
   * @returns {Promise<string>} connection id of the host
   */
  join(code) {
    this.destroy();
    return new Promise((resolve, reject) => {
      const peer = new window.Peer(NETWORK.PEER_OPTIONS);
      this.#peer = peer;
      let settled = false;

      const fail = (err) => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        this.destroy();
        reject(err);
        return true;
      };

      const timer = setTimeout(() => {
        fail(Object.assign(new Error('Could not reach the room. Check the code and try again.'), { type: 'timeout' }));
      }, NETWORK.CONNECT_TIMEOUT_MS);

      peer.on('open', () => {
        const conn = peer.connect(PeerService.peerIdFor(code), { reliable: true, serialization: 'json' });
        conn.on('open', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.#bindConnection(conn, false);
          this.#startHeartbeat();
          resolve(conn.peer);
        });
        conn.on('error', (err) => fail(err));
      });

      this.#bindPeerLifecycle(peer, fail);
    });
  }

  send(connId, data) {
    const entry = this.#conns.get(connId);
    if (!entry || !entry.conn.open) return false;
    try {
      entry.conn.send(data);
      return true;
    } catch (err) {
      console.warn('[PeerService] send failed', err);
      return false;
    }
  }

  /** Closes a single connection without emitting 'disconnect'. */
  closeConnection(connId) {
    const entry = this.#conns.get(connId);
    if (!entry) return;
    this.#conns.delete(connId);
    try {
      entry.conn.close();
    } catch {
      /* ignore */
    }
  }

  /** Tears everything down silently. */
  destroy() {
    clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    for (const id of [...this.#conns.keys()]) this.closeConnection(id);
    if (this.#peer && !this.#peer.destroyed) {
      try {
        this.#peer.destroy();
      } catch {
        /* ignore */
      }
    }
    this.#peer = null;
  }

  // ---------------------------------------------------------------- internals

  #bindPeerLifecycle(peer, onSetupError) {
    peer.on('error', (err) => {
      if (peer !== this.#peer) return;
      // During setup the promise owner handles the error.
      if (onSetupError(err)) return;

      // A remote peer vanished – the data channel close / heartbeat handles it.
      if (err.type === 'peer-unavailable') return;
      console.warn('[PeerService] peer error', err.type, err);
      if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
        // Existing data channels survive losing the signalling server.
        return;
      }
      this.emit('error', err);
    });

    // Lost the signalling server: keep data channels alive, try to re-register
    // so new players (or a reconnecting opponent) can still find us.
    peer.on('disconnected', () => {
      if (peer !== this.#peer || peer.destroyed) return;
      setTimeout(() => {
        if (peer === this.#peer && !peer.destroyed && peer.disconnected) {
          try {
            peer.reconnect();
          } catch {
            /* ignore */
          }
        }
      }, NETWORK.RECONNECT_DELAY_MS);
    });
  }

  #bindConnection(conn, incoming) {
    const register = () => {
      this.#conns.set(conn.peer, { conn, lastSeen: Date.now() });
      if (incoming) this.emit('connection', conn.peer);
    };

    conn.on('data', (data) => {
      const entry = this.#conns.get(conn.peer);
      if (!entry || entry.conn !== conn) return;
      entry.lastSeen = Date.now();
      if (data && data.t === PING) return;
      this.emit('message', conn.peer, data);
    });

    const handleClose = () => {
      const entry = this.#conns.get(conn.peer);
      if (!entry || entry.conn !== conn) return; // already replaced / closed by us
      this.#conns.delete(conn.peer);
      this.emit('disconnect', conn.peer);
    };
    conn.on('close', handleClose);
    conn.on('error', handleClose);

    if (conn.open) register();
    else conn.on('open', register);
  }

  #startHeartbeat() {
    clearInterval(this.#heartbeat);
    this.#heartbeat = setInterval(() => {
      const now = Date.now();
      for (const [id, entry] of this.#conns) {
        if (now - entry.lastSeen > NETWORK.HEARTBEAT_TIMEOUT_MS) {
          this.closeConnection(id);
          this.emit('disconnect', id);
          continue;
        }
        if (entry.conn.open) {
          try {
            entry.conn.send({ t: PING });
          } catch {
            /* close handler will clean up */
          }
        }
      }
    }, NETWORK.HEARTBEAT_INTERVAL_MS);
  }
}
