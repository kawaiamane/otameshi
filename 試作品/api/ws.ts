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

  const directions = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1]
  ];

  for (const [dr, dc] of directions) {
    const r = row + dr;
    const c = col + dc;
    if (r >= 0 && r < ROWS && c >= 0 && c < COLS) {
      result.push(r * COLS + c);
    }
  }

  return result;
}

function makeBoard(target = 1): number[] {
  /*
   * 重要:
   * 以前は「1→2→3→…」そのものを一本の長い経路として
   * 配置していたため、初期状態から24個近くを一気につなげられた。
   *
   * 今回は各数字を完全にバラバラな位置へ置く。
   * ただしゲームが成立するように、
   *  1. 現在のターゲットと次の数字は必ず隣接
   *  2. 連続数字の最大接続長は MAX_INITIAL_CHAIN
   *  3. 同じ数字は二度置かない
   * を満たす盤面だけを採用する。
   */
  const MAX_INITIAL_CHAIN = 3;
  const FUTURE_START = target;
  const futureNumbers = Array.from(
    { length: MAX_NUMBER - target + 1 },
    (_, i) => FUTURE_START + i
  );

  // ダミーは現在以降の数字を一切使わない。
  // したがって「1が複数ある」などの曖昧な盤面は作らない。
  const oldNumbers = Array.from(
    { length: Math.max(0, target - 1) },
    (_, i) => i + 1
  );
  const highNumbers = Array.from(
    { length: SIZE - MAX_NUMBER },
    (_, i) => MAX_NUMBER + 1 + i
  );
  const fillerPool = shuffle([...oldNumbers, ...highNumbers]);

  for (let attempt = 0; attempt < 20000; attempt++) {
    const board = Array<number>(SIZE).fill(0);
    const positions = shuffle(
      Array.from({ length: SIZE }, (_, i) => i)
    );

    // 未来の数字を完全ランダムに配置する。
    for (let i = 0; i < futureNumbers.length; i++) {
      board[positions[i]] = futureNumbers[i];
    }

    // 現在のターゲットから最低2個はつながるようにする。
    if (futureNumbers.length >= 2) {
      const a = futureNumbers[0];
      const b = futureNumbers[1];
      const ia = board.indexOf(a);
      const ib = board.indexOf(b);
      if (!isAdjacent(ia, ib)) continue;
    }

    // 連続した数字の最大ランを調べる。
    let run = 1;
    let maxRun = 1;
    for (let n = target + 1; n <= MAX_NUMBER; n++) {
      const prev = board.indexOf(n - 1);
      const current = board.indexOf(n);
      if (isAdjacent(prev, current)) {
        run++;
        maxRun = Math.max(maxRun, run);
      } else {
        run = 1;
      }
    }

    if (maxRun > MAX_INITIAL_CHAIN) continue;

    // 残りのマスをダミーで埋める。
    let fi = 0;
    for (let i = 0; i < SIZE; i++) {
      if (board[i] === 0) {
        board[i] = fillerPool[fi++ % fillerPool.length];
      }
    }

    return board;
  }

  throw new Error("条件を満たすランダム盤面を生成できませんでした。");
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
  return Math.abs(ar - br) + Math.abs(ac - bc) === 1;
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
  if (!Array.isArray(rawPath) || rawPath.length < 1 || rawPath.length > MAX_NUMBER) return;

  const path = rawPath.map(Number);
  const used = new Set<number>();

  for (let i = 0; i < path.length; i++) {
    const index = path[i];
    if (!Number.isInteger(index) || index < 0 || index >= SIZE || used.has(index)) return;
    used.add(index);

    if (room.board[index] !== room.target + i) return;
    if (i > 0 && !isAdjacent(path[i - 1], index)) return;
  }

  // 24が単独で最後に残った場合も、その1マスを消した瞬間に
  // 次のラウンドへ進めるようにする。
  if (room.target === MAX_NUMBER && path.length === 1 && room.board[path[0]] === MAX_NUMBER) {
    // 正常な最終マス。続行する。
  } else if (path.length < 2) {
    return;
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

  // 24を消し切った場合は、同じ処理の中で即座に新ラウンドを生成する。
  // 「24だけ残って停止する」状態を作らない。
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
