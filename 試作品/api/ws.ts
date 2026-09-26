import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const ROWS = 6;
const COLS = 6;
const SIZE = ROWS * COLS;

const MAX_NUMBER = 24;
const START_TIME = 60;
const EXTENSION_TIME = 1.5;
const MAX_PLAYERS = 2;

const ROOM_CODE_CHARS =
  "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

type ClientSocket = WebSocket & {
  room?: Room;
  playerIndex?: number;
};

type Player = {
  ws: ClientSocket;
  id: number;
};

type Room = {
  code: string;
  players: Player[];

  board: (number | null)[];

  target: number;

  score: number[];

  combo: number;

  timer: number;

  round: number;

  started: boolean;

  timerHandle?: ReturnType<typeof setInterval>;
};


/*
 * Vercel Function のインスタンス内で
 * 現在接続している部屋を管理する。
 */
const rooms =
  new Map<string, Room>();


/* =========================
   基本通信
========================= */

function send(
  ws: WebSocket,
  data: unknown
) {
  if (
    ws.readyState === WebSocket.OPEN
  ) {
    ws.send(
      JSON.stringify(data)
    );
  }
}


function broadcast(
  room: Room,
  data: unknown
) {
  for (
    const player of room.players
  ) {
    send(
      player.ws,
      data
    );
  }
}


/* =========================
   部屋コード
========================= */

function generateRoomCode(): string {

  let code = "";

  do {

    code = "";

    for (
      let i = 0;
      i < 8;
      i++
    ) {

      const index =
        Math.floor(
          Math.random() *
          ROOM_CODE_CHARS.length
        );

      code +=
        ROOM_CODE_CHARS[index];
    }

  } while (
    rooms.has(code)
  );

  return code;
}


/* =========================
   数字生成
========================= */

function randomDummy(): number {

  return (
    Math.floor(
      Math.random() * 9
    ) + 1
  );
}


/*
 * 1～24を盤面上に配置する。
 *
 * 蛇行する形にすることで、
 *
 * 1 → 2 → 3 → ...
 *
 * のルートが必ず存在する。
 */
function makeBoard(): (number | null)[] {

  const board:
    (number | null)[] =
    Array(SIZE).fill(null);

  const startColumn =
    Math.floor(
      Math.random() * 3
    );

  let number = 1;

  for (
    let column = startColumn;
    column < startColumn + 4;
    column++
  ) {

    const reverse =
      (column - startColumn) % 2 === 1;

    if (!reverse) {

      for (
        let row = ROWS - 1;
        row >= 0;
        row--
      ) {

        board[
          row * COLS + column
        ] = number++;

      }

    } else {

      for (
        let row = 0;
        row < ROWS;
        row++
      ) {

        board[
          row * COLS + column
        ] = number++;

      }
    }
  }


  /*
   * 残りのマスをダミー数字で埋める。
   */
  for (
    let i = 0;
    i < SIZE;
    i++
  ) {

    if (
      board[i] === null
    ) {

      board[i] =
        randomDummy();
    }
  }

  return board;
}


/* =========================
   部屋
========================= */

function createRoom(): Room {

  const room: Room = {

    code:
      generateRoomCode(),

    players: [],

    board:
      makeBoard(),

    target: 1,

    score: [0, 0],

    combo: 0,

    timer:
      START_TIME,

    round: 1,

    started: false
  };

  rooms.set(
    room.code,
    room
  );

  return room;
}


function getPublicState(
  room: Room
) {

  return {

    board:
      room.board,

    target:
      room.target,

    score:
      room.score,

    combo:
      room.combo,

    timer:
      room.timer,

    round:
      room.round,

    players:
      room.players.length
  };
}


/* =========================
   ゲーム開始
========================= */

function startGame(
  room: Room
) {

  room.started = true;

  room.board =
    makeBoard();

  room.target = 1;

  room.score = [0, 0];

  room.combo = 0;

  room.timer =
    START_TIME;

  room.round = 1;


  broadcast(
    room,
    {
      type: "start",

      state:
        getPublicState(room)
    }
  );


  room.timerHandle =
    setInterval(
      () => {

        if (
          !room.started
        ) {
          return;
        }


        room.timer =
          Math.max(
            0,
            Math.round(
              (room.timer - 1) * 10
            ) / 10
          );


        broadcast(
          room,
          {
            type: "timer",

            value:
              room.timer
          }
        );


        if (
          room.timer <= 0
        ) {

          finishGame(
            room,
            "time"
          );
        }

      },
      1000
    );
}


/* =========================
   ゲーム終了
========================= */

function finishGame(
  room: Room,
  reason: string
) {

  if (
    !room.started
  ) {
    return;
  }

  room.started = false;


  if (
    room.timerHandle
  ) {

    clearInterval(
      room.timerHandle
    );

    room.timerHandle =
      undefined;
  }


  broadcast(
    room,
    {
      type: "finish",

      reason,

      score:
        room.score,

      round:
        room.round
    }
  );
}


/* =========================
   隣接判定
========================= */

function isAdjacent(
  a: number,
  b: number
): boolean {

  const ar =
    Math.floor(a / COLS);

  const ac =
    a % COLS;

  const br =
    Math.floor(b / COLS);

  const bc =
    b % COLS;


  return (
    Math.abs(ar - br) <= 1 &&
    Math.abs(ac - bc) <= 1 &&
    !(
      ar === br &&
      ac === bc
    )
  );
}


/* =========================
   セルを消して落下
========================= */

function refillColumn(
  room: Room,
  column: number
) {

  const values: number[] = [];


  /*
   * 下から数字を回収
   */
  for (
    let row = ROWS - 1;
    row >= 0;
    row--
  ) {

    const index =
      row * COLS + column;

    const value =
      room.board[index];

    if (
      value !== null
    ) {

      values.push(value);
    }
  }


  /*
   * 下から詰める
   */
  for (
    let row = ROWS - 1,
    i = 0;

    row >= 0;

    row--,
    i++
  ) {

    const index =
      row * COLS + column;

    if (
      i < values.length
    ) {

      room.board[index] =
        values[i];

    } else {

      room.board[index] =
        randomDummy();
    }
  }
}


function removeCells(
  room: Room,
  path: number[]
) {

  const columns =
    new Set<number>();


  for (
    const index of path
  ) {

    room.board[index] =
      null;

    columns.add(
      index % COLS
    );
  }


  for (
    const column of columns
  ) {

    refillColumn(
      room,
      column
    );
  }
}


/* =========================
   チェーン処理
========================= */

function processChain(
  ws: ClientSocket,
  rawPath: unknown
) {

  const room =
    ws.room;

  const player =
    ws.playerIndex;


  if (
    !room ||
    player === undefined ||
    !room.started
  ) {
    return;
  }


  if (
    !Array.isArray(rawPath)
  ) {
    return;
  }


  if (
    rawPath.length < 2 ||
    rawPath.length > MAX_NUMBER
  ) {
    return;
  }


  const path =
    rawPath.map(
      value => Number(value)
    );


  const used =
    new Set<number>();


  /*
   * サーバー側で完全に検証する。
   *
   * クライアント側だけで判定すると、
   * 改造したブラウザから不正なスコアを
   * 送信できてしまうため。
   */
  for (
    let i = 0;
    i < path.length;
    i++
  ) {

    const index =
      path[i];


    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= SIZE ||
      used.has(index)
    ) {

      return;
    }


    used.add(index);


    const expected =
      room.target + i;


    if (
      room.board[index] !==
      expected
    ) {

      return;
    }


    if (
      i > 0 &&
      !isAdjacent(
        path[i - 1],
        index
      )
    ) {

      return;
    }
  }


  /*
   * 次のターゲットへ
   */
  room.target +=
    path.length;


  /*
   * コンボ
   */
  room.combo++;


  /*
   * スコア
   *
   * 長いチェーンほど大きくなる。
   */
  const chainScore =
    path.length *
    path.length *
    10;

  const comboBonus =
    room.combo * 5;


  room.score[player] +=
    chainScore +
    comboBonus;


  /*
   * 2コンボ目以降は
   * 時間を少し延長。
   */
  if (
    room.combo > 1
  ) {

    room.timer =
      Math.min(
        90,
        Math.round(
          (
            room.timer +
            EXTENSION_TIME
          ) * 10
        ) / 10
      );
  }


  /*
   * セルを消して落下
   */
  removeCells(
    room,
    path
  );


  /*
   * 24まで到達したら
   * 新しいラウンド。
   */
  let newRound = false;


  if (
    room.target >
    MAX_NUMBER
  ) {

    newRound = true;

    room.round++;

    room.target = 1;

    room.combo = 0;

    room.board =
      makeBoard();

    room.timer =
      Math.min(
        90,
        room.timer + 5
      );
  }


  /*
   * 1回のメッセージで
   * 全員の盤面を完全同期。
   */
  broadcast(
    room,
    {
      type: "chain",

      player,

      path,

      length:
        path.length,

      combo:
        room.combo,

      target:
        room.target,

      score:
        room.score,

      board:
        room.board,

      timer:
        room.timer,

      round:
        room.round,

      newRound
    }
  );


  /*
   * ラウンド更新
   */
  if (
    newRound
  ) {

    broadcast(
      room,
      {
        type: "round",

        state:
          getPublicState(room)
      }
    );
  }
}


/* =========================
   プレイヤー退出
========================= */

function removePlayer(
  ws: ClientSocket
) {

  const room =
    ws.room;

  if (!room) {
    return;
  }


  room.players =
    room.players.filter(
      player =>
        player.ws !== ws
    );


  /*
   * 誰かが抜けたら
   * 対戦を終了。
   */
  if (
    room.started
  ) {

    finishGame(
      room,
      "disconnect"
    );
  }


  /*
   * 誰もいなくなった部屋は削除。
   */
  if (
    room.players.length === 0
  ) {

    rooms.delete(
      room.code
    );

  } else {

    /*
     * 残ったプレイヤーの
     * 番号を詰め直す。
     */
    room.players.forEach(
      (player, index) => {

        player.id =
          index;

        player.ws.playerIndex =
          index;


        send(
          player.ws,
          {
            type:
              "playerUpdate",

            players:
              room.players.length,

            player:
              index
          }
        );
      }
    );
  }


  ws.room =
    undefined;

  ws.playerIndex =
    undefined;
}


/* =========================
   WebSocket
========================= */

const server =
  createServer(
    (_req, res) => {

      /*
       * WebSocket以外の通常HTTPアクセス。
       */
      res.writeHead(
        200,
        {
          "Content-Type":
            "text/plain; charset=utf-8"
        }
      );

      res.end(
        "NUMBER CHAIN WebSocket server"
      );
    }
  );


const wss =
  new WebSocketServer({
    server
  });


wss.on(
  "connection",
  (ws: ClientSocket) => {

    send(
      ws,
      {
        type: "welcome",

        maxPlayers:
          MAX_PLAYERS
      }
    );


    ws.on(
      "message",
      raw => {

        try {

          const message =
            JSON.parse(
              raw.toString()
            );


          /* =====================
             CREATE ROOM
          ===================== */

          if (
            message.type ===
            "createRoom"
          ) {

            if (
              ws.room
            ) {

              send(
                ws,
                {
                  type: "error",

                  message:
                    "すでに部屋に入っています。"
                }
              );

              return;
            }


            const room =
              createRoom();


            room.players.push({
              ws,
              id: 0
            });


            ws.room =
              room;

            ws.playerIndex =
              0;


            send(
              ws,
              {
                type:
                  "roomCreated",

                room:
                  room.code,

                player:
                  0
              }
            );


            send(
              ws,
              {
                type:
                  "roomState",

                state:
                  getPublicState(room)
              }
            );


            return;
          }


          /* =====================
             JOIN ROOM
          ===================== */

          if (
            message.type ===
            "joinRoom"
          ) {

            if (
              ws.room
            ) {

              send(
                ws,
                {
                  type: "error",

                  message:
                    "すでに部屋に入っています。"
                }
              );

              return;
            }


            const code =
              String(
                message.room ?? ""
              )
              .trim()
              .toUpperCase();


            /*
             * 必ず8文字。
             */
            if (
              !/^[A-Z0-9]{8}$/
                .test(code)
            ) {

              send(
                ws,
                {
                  type: "error",

                  message:
                    "部屋コードは8文字です。"
                }
              );

              return;
            }


            /*
             * 存在しないコードなら拒否。
             */
            const room =
              rooms.get(code);


            if (
              !room
            ) {

              send(
                ws,
                {
                  type: "error",

                  message:
                    "その部屋は存在しません。"
                }
              );

              return;
            }


            /*
             * 2人以上は不可。
             */
            if (
              room.players.length >=
              MAX_PLAYERS
            ) {

              send(
                ws,
                {
                  type: "error",

                  message:
                    "その部屋は満員です。"
                }
              );

              return;
            }


            const player =
              room.players.length;


            room.players.push({
              ws,
              id: player
            });


            ws.room =
              room;

            ws.playerIndex =
              player;


            send(
              ws,
              {
                type:
                  "roomJoined",

                room:
                  room.code,

                player
              }
            );


            broadcast(
              room,
              {
                type:
                  "playerUpdate",

                players:
                  room.players.length
              }
            );


            /*
             * 2人揃ったら開始。
             */
            if (
              room.players.length ===
              MAX_PLAYERS
            ) {

              startGame(room);
            }


            return;
          }


          /* =====================
             CHAIN
          ===================== */

          if (
            message.type ===
            "chain"
          ) {

            processChain(
              ws,
              message.path
            );

            return;
          }


        } catch (error) {

          console.error(
            "Message error:",
            error
          );


          send(
            ws,
            {
              type: "error",

              message:
                "サーバーでエラーが発生しました。"
            }
          );
        }
      }
    );


    ws.on(
      "close",
      () => {
        removePlayer(ws);
      }
    );


    ws.on(
      "error",
      () => {
        removePlayer(ws);
      }
    );
  }
);


/*
 * VercelではHTTPサーバーを
 * listen()するのではなく、
 * server自体をFunctionとしてexportする。
 */
export default server;