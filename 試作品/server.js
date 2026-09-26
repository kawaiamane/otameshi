import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.PORT || 3000);

const ROWS = 6;
const COLS = 6;
const SIZE = ROWS * COLS;

const MAX_NUMBER = 24;
const START_TIME = 60;
const EXTENSION_TIME = 1.5;
const MAX_PLAYERS = 2;

const CODE_CHARS =
  "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

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

  started: boolean;

  round: number;

  timerHandle?: NodeJS.Timeout;
};

type ClientSocket =
  WebSocket & {
    room?: Room;
    playerIndex?: number;
  };

const rooms =
  new Map<string, Room>();


function send(
  ws: WebSocket,
  data: unknown
) {
  if (
    ws.readyState === WebSocket.OPEN
  ) {
    ws.send(JSON.stringify(data));
  }
}


function broadcast(
  room: Room,
  data: unknown
) {
  room.players.forEach(player => {
    send(player.ws, data);
  });
}


function generateRoomCode() {

  let code = "";

  do {

    code = "";

    for (
      let i = 0;
      i < 8;
      i++
    ) {

      code +=
        CODE_CHARS[
          Math.floor(
            Math.random() *
            CODE_CHARS.length
          )
        ];
    }

  } while (
    rooms.has(code)
  );

  return code;
}


function randomDummy() {

  return (
    1 +
    Math.floor(
      Math.random() * 9
    )
  );
}


/*
  1～24を4列に配置する。

  下 → 上
  上 → 下
  下 → 上
  上 → 下

  という蛇行構造にする。

  これが重力で数字を落としても
  次の数字同士の接続を保ちやすくする。
*/
function makeBoard(
  startCol =
    Math.floor(Math.random() * 3)
) {

  const board:
    (number | null)[] =
      Array(SIZE).fill(null);

  let number = 1;

  for (
    let col = startCol;
    col < startCol + 4;
    col++
  ) {

    const even =
      (col - startCol) % 2 === 0;

    if (even) {

      for (
        let row = ROWS - 1;
        row >= 0;
        row--
      ) {

        board[
          row * COLS + col
        ] = number++;

      }

    } else {

      for (
        let row = 0;
        row < ROWS;
        row++
      ) {

        board[
          row * COLS + col
        ] = number++;

      }
    }
  }


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

    started: false,

    round: 1
  };

  rooms.set(
    room.code,
    room
  );

  return room;
}


function publicState(
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


function startGame(
  room: Room
) {

  room.started = true;

  room.target = 1;

  room.combo = 0;

  room.timer =
    START_TIME;

  room.score = [0, 0];

  room.round = 1;

  room.board =
    makeBoard();


  broadcast(
    room,
    {
      type: "start",

      state:
        publicState(room)
    }
  );


  room.timerHandle =
    setInterval(() => {

      if (!room.started) {
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

    }, 1000);
}


function finishGame(
  room: Room,
  reason: string
) {

  if (!room.started) {
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


function adjacent(
  a: number,
  b: number
) {

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


/*
  選択されたセルを消したあと、
  各列だけ下方向に詰める。
*/
function refillColumn(
  room: Room,
  col: number
) {

  const values: number[] = [];


  for (
    let row = ROWS - 1;
    row >= 0;
    row--
  ) {

    const value =
      room.board[
        row * COLS + col
      ];

    if (
      value !== null
    ) {

      values.push(value);
    }
  }


  for (
    let row = ROWS - 1,
    i = 0;

    row >= 0;

    row--,
    i++
  ) {

    room.board[
      row * COLS + col
    ] =
      i < values.length
        ? values[i]
        : randomDummy();
  }
}


function removeCells(
  room: Room,
  path: number[]
) {

  const affected =
    new Set<number>();


  for (
    const index of path
  ) {

    room.board[index] =
      null;

    affected.add(
      index % COLS
    );
  }


  for (
    const col of affected
  ) {

    refillColumn(
      room,
      col
    );
  }
}


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
    rawPath.map(Number);

  const seen =
    new Set<number>();


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
      seen.has(index)
    ) {

      return;
    }


    seen.add(index);


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
      !adjacent(
        path[i - 1],
        index
      )
    ) {

      return;
    }
  }


  const lastValue =
    room.target +
    path.length -
    1;


  room.target =
    lastValue + 1;


  room.combo++;


  /*
    長いチェーンほど
    スコアが大きくなる。
  */
  room.score[player] +=
    path.length *
    path.length *
    10 +
    room.combo * 5;


  /*
    連続チェーンなら
    少しだけ時間を延長。
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


  removeCells(
    room,
    path
  );


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
        room.timer
    }
  );


  /*
    24まで行ったら
    新しい盤面へ。
  */
  if (
    room.target >
    MAX_NUMBER
  ) {

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


    broadcast(
      room,
      {
        type: "round",

        state:
          publicState(room)
      }
    );
  }
}


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


  if (room.started) {

    finishGame(
      room,
      "disconnect"
    );
  }


  if (
    room.players.length === 0
  ) {

    rooms.delete(
      room.code
    );

  } else {

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


const html =
  readFileSync(
    join(
      process.cwd(),
      "index.html"
    ),
    "utf8"
  );


const server =
  createServer(
    (req, res) => {

      if (
        req.url === "/" ||
        req.url === "/index.html"
      ) {

        res.writeHead(
          200,
          {
            "content-type":
              "text/html; charset=utf-8",

            "cache-control":
              "no-store"
          }
        );

        res.end(html);

        return;
      }


      res.writeHead(404);

      res.end(
        "Not found"
      );
    }
  );


/*
  Vercel / Node.js
  WebSocket endpoint
*/
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
        type:
          "welcome",

        maxPlayers:
          MAX_PLAYERS
      }
    );


    ws.on(
      "message",
      raw => {

        try {

          const msg =
            JSON.parse(
              raw.toString()
            );


          /*
            部屋作成
          */
          if (
            msg.type ===
            "createRoom"
          ) {

            if (ws.room) {

              send(
                ws,
                {
                  type:
                    "error",

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
                  publicState(room)
              }
            );


            return;
          }


          /*
            部屋参加
          */
          if (
            msg.type ===
            "joinRoom"
          ) {

            if (ws.room) {

              send(
                ws,
                {
                  type:
                    "error",

                  message:
                    "すでに部屋に入っています。"
                }
              );

              return;
            }


            const code =
              String(
                msg.room || ""
              )
              .trim()
              .toUpperCase();


            if (
              !/^[A-Z0-9]{8}$/
                .test(code)
            ) {

              send(
                ws,
                {
                  type:
                    "error",

                  message:
                    "部屋コードは8文字です。"
                }
              );

              return;
            }


            const room =
              rooms.get(code);


            if (!room) {

              send(
                ws,
                {
                  type:
                    "error",

                  message:
                    "その8文字の部屋は存在しません。"
                }
              );

              return;
            }


            if (
              room.players.length >=
              MAX_PLAYERS
            ) {

              send(
                ws,
                {
                  type:
                    "error",

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


            if (
              room.players.length ===
              MAX_PLAYERS
            ) {

              startGame(room);
            }


            return;
          }


          /*
            チェーン
          */
          if (
            msg.type ===
            "chain"
          ) {

            processChain(
              ws,
              msg.path
            );

            return;
          }

        } catch {

          send(
            ws,
            {
              type:
                "error",

              message:
                "通信データを読み取れませんでした。"
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


server.listen(
  PORT,
  () => {

    console.log(
      `NUMBER CHAIN listening on ${PORT}`
    );

  }
);