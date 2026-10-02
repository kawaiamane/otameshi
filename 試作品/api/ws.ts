import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const ROWS = 6;
const COLS = 6;
const SIZE = ROWS * COLS;
const MAX_NUMBER = 24;
const START_TIME = 60;
const EXTENSION_TIME = 1.5;
const MAX_PLAYERS = 2;
const MAX_ROOMS = 500;
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

type ClientSocket = WebSocket & {
  room?: Room;
  playerIndex?: number;
  cleanedUp?: boolean;
};

type Player = { ws: ClientSocket; id: number };

type Room = {
  code: string;
  players: Player[];
  board: number[];
  target: number;
  score: number[];
  combo: number;
  timer: number;
  round: number;
  started: boolean;
  timerHandle?: ReturnType<typeof setInterval>;
};

const rooms = new Map<string, Room>();

function send(ws: WebSocket, data: unknown) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function broadcast(room: Room, data: unknown) {
  for (const player of [...room.players]) send(player.ws, data);
}

function generateRoomCode(): string {
  for (;;) {
    let code = "";
    for (let i = 0; i < 8; i++) {
      code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    }
    if (!rooms.has(code)) return code;
  }
}

function randomDummy(): number {
  return Math.floor(Math.random() * 9) + 1;
}

function shuffle<T>(array: T[]): T[] {
  const a = [...array];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function neighbors(index: number): number[] {
  const row = Math.floor(index / COLS);
  const col = index % COLS;
  const result: number[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const r = row + dr;
      const c = col + dc;
      if (r >= 0 && r < ROWS && c >= 0 && c < COLS) {
        result.push(r * COLS + c);
      }
    }
  }
  return result;
}

/*
 * 1～24の「位置」は毎回ランダムに決める。
 * ただしゲームとして必ず 1→2→…→24 と進められるよう、
 * 24マスのランダムな自己回避経路を作ってから番号を置く。
 * つまり蛇行固定配置ではなく、毎回違うランダム盤面になる。
 */
function makeRandomPath(length: number): number[] {
  const maxAttempts = 5000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const start = Math.floor(Math.random() * SIZE);
    const path = [start];
    const used = new Set([start]);

    const dfs = (): boolean => {
      if (path.length === length) return true;

      const current = path[path.length - 1];
      const candidates = shuffle(neighbors(current)).filter(x => !used.has(x));

      // 先の選択肢が少ないマスを優先して、行き止まりを減らす。
      candidates.sort((a, b) => {
        const da = neighbors(a).filter(x => !used.has(x)).length;
        const db = neighbors(b).filter(x => !used.has(x)).length;
        return da - db + (Math.random() - 0.5) * 2;
      });

      for (const next of candidates) {
        used.add(next);
        path.push(next);
        if (dfs()) return true;
        path.pop();
        used.delete(next);
      }
      return false;
    };

    if (dfs()) return path;
  }

  throw new Error("ランダム経路を生成できませんでした。");
}

function makeBoard(target = 1): number[] {
  const board = Array<number>(SIZE).fill(0);
  const remaining = MAX_NUMBER - target + 1;
  const path = makeRandomPath(remaining);

  path.forEach((index, i) => {
    board[index] = target + i;
  });

  for (let i = 0; i < SIZE; i++) {
    if (board[i] === 0) board[i] = randomDummy();
  }

  return board;
}

function createRoom(): Room {
  if (rooms.size >= MAX_ROOMS) throw new Error("現在、部屋数が上限に達しています。");

  const room: Room = {
    code: generateRoomCode(),
    players: [],
    board: makeBoard(1),
    target: 1,
    score: [0, 0],
    combo: 0,
    timer: START_TIME,
    round: 1,
    started: false
  };

  rooms.set(room.code, room);
  return room;
}

function getPublicState(room: Room) {
  return {
    board: room.board,
    target: room.target,
    score: room.score,
    combo: room.combo,
    timer: room.timer,
    round: room.round,
    players: room.players.length
  };
}

function startGame(room: Room) {
  if (room.started || room.players.length !== MAX_PLAYERS) return;

  room.started = true;
  room.target = 1;
  room.score = [0, 0];
  room.combo = 0;
  room.timer = START_TIME;
  room.round = 1;
  room.board = makeBoard(1);

  broadcast(room, { type: "start", state: getPublicState(room) });

  if (room.timerHandle) clearInterval(room.timerHandle);
  room.timerHandle = setInterval(() => {
    if (!room.started) return;

    room.timer = Math.max(0, Math.round((room.timer - 1) * 10) / 10);
    broadcast(room, { type: "timer", value: room.timer });

    if (room.timer <= 0) finishGame(room, "time");
  }, 1000);
}

function finishGame(room: Room, reason: string) {
  if (!room.started) return;

  room.started = false;
  if (room.timerHandle) {
    clearInterval(room.timerHandle);
    room.timerHandle = undefined;
  }

  broadcast(room, {
    type: "finish",
    reason,
    score: [...room.score],
    round: room.round
  });
}

function isAdjacent(a: number, b: number): boolean {
  const ar = Math.floor(a / COLS), ac = a % COLS;
  const br = Math.floor(b / COLS), bc = b % COLS;
  return Math.abs(ar - br) <= 1 && Math.abs(ac - bc) <= 1 && !(ar === br && ac === bc);
}

function rebuildBoard(room: Room) {
  // 次のターゲットから24までを新しいランダム経路に置く。
  // これにより、チェーン後も必ず続けられる。
  room.board = makeBoard(room.target);
}

function processChain(ws: ClientSocket, rawPath: unknown) {
  const room = ws.room;
  const player = ws.playerIndex;
  if (!room || player === undefined || !room.started) return;
  if (!Array.isArray(rawPath) || rawPath.length < 2 || rawPath.length > MAX_NUMBER) return;

  const path = rawPath.map(Number);
  const used = new Set<number>();

  for (let i = 0; i < path.length; i++) {
    const index = path[i];
    if (!Number.isInteger(index) || index < 0 || index >= SIZE || used.has(index)) return;
    used.add(index);

    if (room.board[index] !== room.target + i) return;
    if (i > 0 && !isAdjacent(path[i - 1], index)) return;
  }

  room.target += path.length;
  room.combo++;

  room.score[player] += path.length * path.length * 10 + room.combo * 5;

  if (room.combo > 1) {
    room.timer = Math.min(90, Math.round((room.timer + EXTENSION_TIME) * 10) / 10);
  }

  let newRound = false;
  if (room.target > MAX_NUMBER) {
    newRound = true;
    room.round++;
    room.target = 1;
    room.combo = 0;
    room.timer = Math.min(90, room.timer + 5);
  }

  rebuildBoard(room);

  broadcast(room, {
    type: "chain",
    player,
    path,
    length: path.length,
    combo: room.combo,
    target: room.target,
    score: [...room.score],
    board: room.board,
    timer: room.timer,
    round: room.round,
    newRound
  });

  if (newRound) {
    broadcast(room, { type: "round", state: getPublicState(room) });
  }
}

function leaveRoom(ws: ClientSocket, notify = true) {
  if (ws.cleanedUp) return;
  const room = ws.room;
  if (!room) return;

  ws.cleanedUp = true;

  const index = room.players.findIndex((p: Player) => p.ws === ws);
  if (index >= 0) room.players.splice(index, 1);

  if (room.started) finishGame(room, "disconnect");

  ws.room = undefined;
  ws.playerIndex = undefined;

  // 残ったプレイヤーには新しい番号を振る。
  room.players.forEach((player: Player, i: number) => {
    player.id = i;
    player.ws.playerIndex = i;
    send(player.ws, { type: "playerUpdate", players: room.players.length, player: i });
  });

  if (notify) send(ws, { type: "leftRoom" });

  if (room.players.length === 0) {
    if (room.timerHandle) clearInterval(room.timerHandle);
    rooms.delete(room.code);
  }
}

function handleMessage(ws: ClientSocket, message: any) {
  if (message.type === "createRoom") {
    if (ws.room) {
      send(ws, { type: "error", message: "すでに部屋に入っています。" });
      return;
    }

    const room = createRoom();
    ws.cleanedUp = false;
    room.players.push({ ws, id: 0 });
    ws.room = room;
    ws.playerIndex = 0;

    send(ws, { type: "roomCreated", room: room.code, player: 0 });
    send(ws, { type: "roomState", state: getPublicState(room) });
    return;
  }

  if (message.type === "joinRoom") {
    if (ws.room) {
      send(ws, { type: "error", message: "すでに部屋に入っています。" });
      return;
    }

    const code = String(message.room ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9]{8}$/.test(code)) {
      send(ws, { type: "error", message: "部屋コードは8文字です。" });
      return;
    }

    const room = rooms.get(code);
    if (!room) {
      send(ws, { type: "error", message: "その部屋は存在しません。" });
      return;
    }
    if (room.players.length >= MAX_PLAYERS) {
      send(ws, { type: "error", message: "その部屋は満員です。" });
      return;
    }
    if (room.started) {
      send(ws, { type: "error", message: "その対戦はすでに開始されています。" });
      return;
    }

    const player = room.players.length;
    ws.cleanedUp = false;
    room.players.push({ ws, id: player });
    ws.room = room;
    ws.playerIndex = player;

    send(ws, { type: "roomJoined", room: room.code, player });
    broadcast(room, { type: "playerUpdate", players: room.players.length });

    if (room.players.length === MAX_PLAYERS) startGame(room);
    return;
  }

  if (message.type === "leaveRoom") {
    leaveRoom(ws);
    return;
  }

  if (message.type === "chain") {
    processChain(ws, message.path);
    return;
  }
}

const server = createServer((_req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("NUMBER CHAIN WebSocket server");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws: ClientSocket) => {
  ws.cleanedUp = false;
  send(ws, { type: "welcome", maxPlayers: MAX_PLAYERS });

  ws.on("message", (raw: Buffer) => {
    try {
      const message = JSON.parse(raw.toString());
      handleMessage(ws, message);
    } catch (error) {
      console.error("Message error:", error);
      send(ws, { type: "error", message: "サーバーでエラーが発生しました。" });
    }
  });

  ws.on("close", () => leaveRoom(ws, false));
  ws.on("error", () => leaveRoom(ws, false));
});

export default server;
