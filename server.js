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
  cors: { origin: "*" }
});

const uploadDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => {
    cb(null, uploadDir);
  },

  filename: (_, file, cb) => {
    const ext =
      path.extname(file.originalname).toLowerCase() || ".mp4";

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
    if (
      String(file.mimetype || "").startsWith("video/")
    ) {
      cb(null, true);
    } else {
      cb(new Error("فقط فایل ویدئویی مجاز است."));
    }
  }
});

app.use(express.static(__dirname));
app.use("/uploads", express.static(uploadDir));

app.get("/health", (_, res) => {
  res.json({
    ok: true,
    app: "باهم ببینیم - Stream"
  });
});

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
        encodeURIComponent(req.file.filename),
      name: req.file.originalname,
      mime: req.file.mimetype,
      size: req.file.size
    });
  },
  (err, _, res, __) => {
    res.status(400).json({
      error:
        err?.message || "آپلود ناموفق بود."
    });
  }
);

const rooms = new Map();

io.on("connection", socket => {

  socket.on("join-room", ({ roomCode, name }) => {

    const code = String(roomCode || "")
      .trim()
      .toUpperCase();

    const cleanName = String(name || "")
      .trim()
      .slice(0, 30);

    if (!code || !cleanName) {
      return socket.emit(
        "room-error",
        "نام و کد روم الزامی است."
      );
    }

    let room = rooms.get(code);

    if (!room) {
      room = {
        hostId: socket.id,

        users: new Map(),

        source: null,

        playback: {
          playing: false,
          time: 0,
          at: Date.now()
        }
      };

      rooms.set(code, room);
    }

    if (room.users.size >= 2) {
      return socket.emit(
        "room-error",
        "این روم در حال حاضر دو نفر دارد."
      );
    }

    const role =
      room.users.size === 0
        ? "host"
        : "guest";

    if (role === "host") {
      room.hostId = socket.id;
    }

    socket.join(code);

    socket.data.roomCode = code;
    socket.data.name = cleanName;
    socket.data.role = role;

    room.users.set(socket.id, {
      id: socket.id,
      name: cleanName,
      role
    });

    socket.emit("joined-room", {
      roomCode: code,
      role,
      users: [...room.users.values()],
      source: room.source,
      playback: room.playback
    });

    io.to(code).emit("room-users", {
      users: [...room.users.values()]
    });
  });


  socket.on("set-source", source => {

    const code = socket.data.roomCode;
    const room = rooms.get(code);

    if (
      !room ||
      socket.id !== room.hostId ||
      !source?.url
    ) {
      return;
    }

    room.source = {
      type:
        source.type === "upload"
          ? "upload"
          : "url",

      url: String(source.url),

      name: String(
        source.name || "ویدئو"
      ).slice(0, 200),

      mime: String(
        source.mime || ""
      ).slice(0, 100),

      version: Date.now()
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
  });


  socket.on("playback", data => {

    const code = socket.data.roomCode;
    const room = rooms.get(code);

    const time = Number(
      data?.time
    );

    if (
      !room ||
      !room.source ||
      !Number.isFinite(time)
    ) {
      return;
    }

    if (socket.id !== room.hostId) {
      return;
    }

    room.playback = {
      playing: !!data.playing,
      time,
      at: Date.now()
    };

    socket
      .to(code)
      .emit(
        "playback",
        room.playback
      );
  });


  socket.on("chat", text => {

    const code = socket.data.roomCode;
    const room = rooms.get(code);

    if (!room) {
      return;
    }

    const message = String(text || "")
      .trim()
      .slice(0, 500);

    if (!message) {
      return;
    }

    io.to(code).emit("chat", {
      id:
        socket.id +
        Date.now(),

      name:
        socket.data.name,

      text: message,

      time:
        new Date().toISOString()
    });
  });


  socket.on("disconnect", () => {

    const code =
      socket.data.roomCode;

    const room =
      rooms.get(code);

    if (!room) {
      return;
    }

    const wasHost =
      socket.id === room.hostId;

    room.users.delete(
      socket.id
    );

    if (room.users.size === 0) {
      rooms.delete(code);
      return;
    }

    if (wasHost) {

      const next =
        room.users
          .values()
          .next()
          .value;

      if (next) {

        room.hostId = next.id;

        next.role = "host";

        room.users.set(
          next.id,
          next
        );

        const nextSocket =
          io.sockets.sockets.get(
            next.id
          );

        if (nextSocket) {
          nextSocket.data.role =
            "host";
        }

        io.to(code).emit(
          "host-changed",
          {
            hostId: next.id
          }
        );
      }
    }

    io.to(code).emit(
      "room-users",
      {
        users: [
          ...room.users.values()
        ]
      }
    );
  });

});


const PORT =
  process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(
    "Hamnama Stream on port " +
    PORT
  );
});
