const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

const MAX_ROOM_USERS = 4;

// ================================
// تنظیمات اصلی
// ================================

const HOST_CODE = "tbolandghamat";

// ================================
// Upload
// ================================

const uploadDir = path.join(__dirname, "uploads");

fs.mkdirSync(uploadDir, {
  recursive: true
});

const storage = multer.diskStorage({
  destination: (_, __, cb) => {
    cb(null, uploadDir);
  },

  filename: (_, file, cb) => {
    const ext =
      path.extname(file.originalname).toLowerCase() ||
      ".mp4";

    cb(
      null,
      crypto.randomBytes(16).toString("hex") + ext
    );
  }
});

const upload = multer({
  storage,

  limits: {
    fileSize: 1024 * 1024 * 1024
  },

  fileFilter: (_, file, cb) => {
    const mime = String(file.mimetype || "");

    if (
      mime.startsWith("video/") ||
      mime === "application/octet-stream"
    ) {
      cb(null, true);
    } else {
      cb(
        new Error(
          "فقط فایل ویدئویی مجاز است."
        )
      );
    }
  }
});

// ================================
// Static files
// ================================

app.use(express.static(__dirname));

app.use(
  "/uploads",
  express.static(uploadDir)
);

// ================================
// Health
// ================================

app.get("/health", (_, res) => {
  res.json({
    ok: true,
    app: "باهم ببینیم - Stream",
    maxUsers: MAX_ROOM_USERS
  });
});

// ================================
// Upload API
// ================================

app.post(
  "/api/upload",
  upload.single("video"),

  (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        error: "فایلی دریافت نشد."
      });
    }

    res.json({
      ok: true,

      url:
        "/uploads/" +
        encodeURIComponent(
          req.file.filename
        ),

      name:
        req.file.originalname,

      mime:
        req.file.mimetype,

      size:
        req.file.size
    });
  },

  (err, _, res, __) => {
    res.status(400).json({
      error:
        err?.message ||
        "آپلود ناموفق بود."
    });
  }
);

// ================================
// Rooms
// ================================

const rooms = new Map();

// ================================
// Helpers
// ================================

function hashHostCode(code) {
  return crypto
    .createHash("sha256")
    .update(String(code))
    .digest("hex");
}

const HOST_CODE_HASH =
  hashHostCode(HOST_CODE);

function verifyHostCode(code) {
  return (
    hashHostCode(code) ===
    HOST_CODE_HASH
  );
}

function roomUserList(room) {
  return [
    ...room.users.values()
  ];
}

function emitRoomState(code, room) {
  io.to(code).emit(
    "room-users",
    {
      users:
        roomUserList(room),

      maxUsers:
        MAX_ROOM_USERS,

      hostId:
        room.hostId || null
    }
  );
}

// ================================
// Socket.IO
// ================================

io.on("connection", socket => {

  // ==============================
  // Join room
  // ==============================

  socket.on(
    "join-room",
    ({
      roomCode,
      name,
      hostCode,
      wantsHost
    } = {}) => {

      const code =
        String(roomCode || "")
          .trim()
          .toUpperCase();

      const cleanName =
        String(name || "")
          .trim()
          .slice(0, 30);

      const cleanHostCode =
        String(hostCode || "")
          .trim();

      const requestHost =
        wantsHost === true;

      if (!code || !cleanName) {
        return socket.emit(
          "room-error",
          "نام و کد روم الزامی است."
        );
      }

      let room =
        rooms.get(code);

      // --------------------------
      // Create room
      // --------------------------

      if (!room) {

        room = {
          hostId: null,

          users:
            new Map(),

          source:
            null,

          playback: {
            playing: false,
            time: 0,
            at: Date.now()
          }
        };

        rooms.set(
          code,
          room
        );
      }

      // --------------------------
      // Room capacity
      // --------------------------

      if (
        room.users.size >=
        MAX_ROOM_USERS
      ) {
        return socket.emit(
          "room-error",
          `این روم پر است. حداکثر ${MAX_ROOM_USERS} نفر می‌توانند وارد شوند.`
        );
      }

      let role = "guest";

      // --------------------------
      // Host login
      // --------------------------

      if (requestHost) {

        if (room.hostId) {
          return socket.emit(
            "room-error",
            "این روم در حال حاضر یک Host دارد."
          );
        }

        if (
          !verifyHostCode(
            cleanHostCode
          )
        ) {
          return socket.emit(
            "room-error",
            "Host Code اشتباه است."
          );
        }

        role = "host";

        room.hostId =
          socket.id;
      }

      // --------------------------
      // Join socket room
      // --------------------------

      socket.join(code);

      socket.data.roomCode =
        code;

      socket.data.name =
        cleanName;

      socket.data.role =
        role;

      const user = {
        id:
          socket.id,

        name:
          cleanName,

        role
      };

      room.users.set(
        socket.id,
        user
      );

      // --------------------------
      // Send joined state
      // --------------------------

      socket.emit(
        "joined-room",
        {
          roomCode:
            code,

          role,

          users:
            roomUserList(room),

          source:
            room.source,

          playback:
            room.playback,

          maxUsers:
            MAX_ROOM_USERS,

          hostId:
            room.hostId || null
        }
      );

      emitRoomState(
        code,
        room
      );
    }
  );

  // ==============================
  // Become Host
  // ==============================

  socket.on(
    "become-host",
    ({
      hostCode
    } = {}) => {

      const code =
        socket.data.roomCode;

      const room =
        rooms.get(code);

      if (!room) {
        return;
      }

      if (room.hostId) {
        return socket.emit(
          "room-error",
          "این روم در حال حاضر Host دارد."
        );
      }

      const cleanCode =
        String(hostCode || "")
          .trim();

      if (
        !verifyHostCode(
          cleanCode
        )
      ) {
        return socket.emit(
          "room-error",
          "Host Code اشتباه است."
        );
      }

      room.hostId =
        socket.id;

      const user =
        room.users.get(
          socket.id
        );

      if (user) {

        user.role =
          "host";

        room.users.set(
          socket.id,
          user
        );
      }

      socket.data.role =
        "host";

      io.to(code).emit(
        "host-changed",
        {
          hostId:
            socket.id
        }
      );

      emitRoomState(
        code,
        room
      );

      socket.emit(
        "became-host"
      );
    }
  );

  // ==============================
  // Set video source
  // ==============================

  socket.on(
    "set-source",
    source => {

      const code =
        socket.data.roomCode;

      const room =
        rooms.get(code);

      if (
        !room ||
        socket.id !==
          room.hostId ||
        !source?.url
      ) {
        return;
      }

      room.source = {

        type:
          source.type === "upload"
            ? "upload"
            : "url",

        url:
          String(source.url),

        name:
          String(
            source.name ||
            "ویدئو"
          ).slice(0, 200),

        mime:
          String(
            source.mime || ""
          ).slice(0, 100),

        version:
          Date.now()
      };

      room.playback = {
        playing: false,
        time: 0,
        at: Date.now()
      };

      io.to(code).emit(
        "media-source",
        room.source
      );

      io.to(code).emit(
        "playback",
        room.playback
      );
    }
  );

  // ==============================
  // Playback synchronization
  // ==============================

  socket.on(
    "playback",
    data => {

      const code =
        socket.data.roomCode;

      const room =
        rooms.get(code);

      const time =
        Number(
          data?.time
        );

      if (
        !room ||
        !room.source ||
        !Number.isFinite(time)
      ) {
        return;
      }

      if (
        socket.id !==
        room.hostId
      ) {
        return;
      }

      room.playback = {

        playing:
          !!data.playing,

        time,

        at:
          Date.now()
      };

      socket
        .to(code)
        .emit(
          "playback",
          room.playback
        );
    }
  );

  // ==============================
  // Chat
  // ==============================

  socket.on(
    "chat",
    text => {

      const code =
        socket.data.roomCode;

      const room =
        rooms.get(code);

      if (!room) {
        return;
      }

      const message =
        String(text || "")
          .trim()
          .slice(0, 500);

      if (!message) {
        return;
      }

      io.to(code).emit(
        "chat",
        {
          id:
            socket.id +
            Date.now(),

          name:
            socket.data.name,

          text:
            message,

          time:
            new Date()
              .toISOString()
        }
      );
    }
  );

  // ==============================
  // Voice: Offer
  // ==============================

  socket.on(
    "voice-offer",
    ({
      target,
      offer
    } = {}) => {

      if (
        !target ||
        !offer
      ) {
        return;
      }

      io.to(target).emit(
        "voice-offer",
        {
          from:
            socket.id,

          name:
            socket.data.name,

          offer
        }
      );
    }
  );

  // ==============================
  // Voice: Answer
  // ==============================

  socket.on(
    "voice-answer",
    ({
      target,
      answer
    } = {}) => {

      if (
        !target ||
        !answer
      ) {
        return;
      }

      io.to(target).emit(
        "voice-answer",
        {
          from:
            socket.id,

          answer
        }
      );
    }
  );

  // ==============================
  // Voice: ICE
  // ==============================

  socket.on(
    "voice-ice",
    ({
      target,
      candidate
    } = {}) => {

      if (
        !target ||
        !candidate
      ) {
        return;
      }

      io.to(target).emit(
        "voice-ice",
        {
          from:
            socket.id,

          candidate
        }
      );
    }
  );

  // ==============================
  // Voice state
  // ==============================

  socket.on(
    "voice-state",
    ({
      enabled
    } = {}) => {

      const code =
        socket.data.roomCode;

      if (!code) {
        return;
      }

      socket
        .to(code)
        .emit(
          "voice-state",
          {
            id:
              socket.id,

            name:
              socket.data.name,

            enabled:
              !!enabled
          }
        );
    }
  );

  // ==============================
  // Disconnect
  // ==============================

  socket.on(
    "disconnect",
    () => {

      const code =
        socket.data.roomCode;

      const room =
        rooms.get(code);

      if (!room) {
        return;
      }

      const wasHost =
        socket.id ===
        room.hostId;

      room.users.delete(
        socket.id
      );

      // Host left
      if (wasHost) {

        room.hostId =
          null;

        io.to(code).emit(
          "host-changed",
          {
            hostId: null
          }
        );
      }

      // Empty room
      if (
        room.users.size === 0
      ) {
        rooms.delete(code);
        return;
      }

      emitRoomState(
        code,
        room
      );
    }
  );
});

// ================================
// Start server
// ================================

const PORT =
  process.env.PORT || 3001;

server.listen(
  PORT,
  () => {
    console.log(
      "Hamnama Stream running on port " +
      PORT
    );
  }
);
