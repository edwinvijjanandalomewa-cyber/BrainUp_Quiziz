const path = require("node:path");
const { randomInt } = require("node:crypto");
const express = require("express");
const { createServer } = require("node:http");
const { Server } = require("socket.io");

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const rooms = new Map();
const port = Number(process.env.PORT) || 3000;

app.get(["/", "/index.html"], (request, response) => {
	response.sendFile(path.join(__dirname, "index.html"));
});
app.get("/style.css", (request, response) => {
	response.sendFile(path.join(__dirname, "style.css"));
});
app.get("/sript.js", (request, response) => {
	response.sendFile(path.join(__dirname, "sript.js"));
});

function normalizeAnswer(value) {
	return value.trim().toLocaleLowerCase("id-ID").replace(/\s+/g, " ");
}

function publicQuestions(room) {
	return room.questions.map((question) => ({
		text: question.text,
		...(room.questionType === "multiple" ? { choices: question.choices } : {}),
	}));
}

function roomStatus(room) {
	return {
		code: room.code,
		theme: room.theme,
		hostName: room.hostName,
		started: room.started,
		players: [...room.players.values()].map((player) => ({
			name: player.name,
			correctCount: player.correctCount,
			answeredCount: player.answers.length,
			finished: player.finished,
			connected: player.connected,
		})),
	};
}

function createRoomCode() {
	let code;
	do {
		code = String(randomInt(100000, 1000000));
	} while (rooms.has(code));
	return code;
}

function validateQuiz(payload) {
	if (!payload || !["short", "multiple"].includes(payload.questionType)) return null;
	if (!Array.isArray(payload.questions) || payload.questions.length < 1 || payload.questions.length > 50) return null;

	const questions = payload.questions.map((question) => {
		const text = typeof question.text === "string" ? question.text.trim().slice(0, 180) : "";
		if (!text) return null;

		if (payload.questionType === "multiple") {
			if (!Array.isArray(question.choices) || question.choices.length !== 4) return null;
			const choices = question.choices.map((choice) => typeof choice === "string" ? choice.trim().slice(0, 100) : "");
			if (choices.some((choice) => !choice) || !Number.isInteger(question.correctChoice) || question.correctChoice < 0 || question.correctChoice > 3) return null;
			return { text, choices, correctChoice: question.correctChoice };
		}

		const acceptedAnswers = Array.isArray(question.acceptedAnswers)
			? question.acceptedAnswers.map((answer) => typeof answer === "string" ? answer.trim().slice(0, 120) : "").filter(Boolean)
			: [];
		if (acceptedAnswers.length === 0) return null;
		return { text, acceptedAnswers };
	});

	if (questions.some((question) => !question)) return null;
	return {
		hostName: String(payload.hostName || "").trim().slice(0, 40),
		theme: String(payload.theme || "").trim().slice(0, 50),
		questionType: payload.questionType,
		questions,
	};
}

io.on("connection", (socket) => {
	socket.on("host:create", (payload, acknowledge = () => {}) => {
		const quiz = validateQuiz(payload);
		if (!quiz || !quiz.hostName || !quiz.theme) {
			acknowledge({ ok: false, message: "Periksa nama, tema, dan semua soal terlebih dahulu." });
			return;
		}

		const code = createRoomCode();
		const room = {
			...quiz,
			code,
			hostSocketId: socket.id,
			players: new Map(),
			started: false,
		};
		rooms.set(code, room);
		socket.join(code);
		socket.data.roomCode = code;
		socket.data.role = "host";
		acknowledge({ ok: true, code });
		io.to(code).emit("room:update", roomStatus(room));
	});

	socket.on("participant:join", (payload, acknowledge = () => {}) => {
		const code = String(payload?.code || "").trim();
		const name = String(payload?.name || "").trim().slice(0, 40);
		const room = rooms.get(code);
		if (!/^\d{6}$/.test(code) || !room) {
			acknowledge({ ok: false, message: "Kode kuis tidak ditemukan. Periksa kembali 6 angkanya." });
			return;
		}
		if (room.started) {
			acknowledge({ ok: false, message: "Kuis ini sudah dimulai dan tidak menerima peserta baru." });
			return;
		}
		if (!name) {
			acknowledge({ ok: false, message: "Masukkan nama peserta terlebih dahulu." });
			return;
		}

		room.players.set(socket.id, { name, answers: [], correctCount: 0, finished: false, connected: true });
		socket.join(code);
		socket.data.roomCode = code;
		socket.data.role = "participant";
		acknowledge({
			ok: true,
			code,
			name,
			hostName: room.hostName,
			theme: room.theme,
		});
		io.to(code).emit("room:update", roomStatus(room));
	});

	socket.on("host:start", (acknowledge = () => {}) => {
		const room = rooms.get(socket.data.roomCode);
		if (!room || room.hostSocketId !== socket.id || room.started) {
			acknowledge({ ok: false, message: "Ruang kuis tidak tersedia." });
			return;
		}
		if (room.players.size === 0) {
			acknowledge({ ok: false, message: "Tunggu setidaknya satu peserta bergabung." });
			return;
		}

		room.started = true;
		io.to(room.code).emit("quiz:start", {
			questionType: room.questionType,
			theme: room.theme,
			questions: publicQuestions(room),
		});
		io.to(room.code).emit("room:update", roomStatus(room));
		acknowledge({ ok: true });
	});

	socket.on("participant:answer", (payload, acknowledge = () => {}) => {
		const room = rooms.get(socket.data.roomCode);
		const player = room?.players.get(socket.id);
		if (!room || !room.started || !player || player.finished) {
			acknowledge({ ok: false, message: "Sesi kuis tidak aktif." });
			return;
		}

		const questionIndex = player.answers.length;
		if (payload?.questionIndex !== questionIndex || questionIndex >= room.questions.length) {
			acknowledge({ ok: false, message: "Jawaban untuk soal ini sudah dikirim atau tidak valid." });
			return;
		}

		const question = room.questions[questionIndex];
		let submitted;
		let isCorrect;
		let expectedAnswers;
		if (room.questionType === "multiple") {
			const choiceIndex = Number(payload.choiceIndex);
			if (!Number.isInteger(choiceIndex) || choiceIndex < 0 || choiceIndex > 3) {
				acknowledge({ ok: false, message: "Pilih salah satu jawaban A sampai D." });
				return;
			}
			submitted = `${String.fromCharCode(65 + choiceIndex)}. ${question.choices[choiceIndex]}`;
			isCorrect = choiceIndex === question.correctChoice;
			expectedAnswers = [`${String.fromCharCode(65 + question.correctChoice)}. ${question.choices[question.correctChoice]}`];
		} else {
			submitted = typeof payload.answer === "string" ? payload.answer.trim().slice(0, 180) : "";
			if (!submitted) {
				acknowledge({ ok: false, message: "Jawaban tidak boleh kosong." });
				return;
			}
			isCorrect = question.acceptedAnswers.some((answer) => normalizeAnswer(answer) === normalizeAnswer(submitted));
			expectedAnswers = question.acceptedAnswers;
		}

		player.answers.push({ question: question.text, submitted, expectedAnswers, isCorrect });
		if (isCorrect) player.correctCount += 1;
		if (player.answers.length === room.questions.length) player.finished = true;
		acknowledge({ ok: true, isCorrect, submitted, expectedAnswers });
		io.to(room.code).emit("room:update", roomStatus(room));
	});

	socket.on("disconnect", () => {
		const code = socket.data.roomCode;
		const room = rooms.get(code);
		if (!room) return;
		if (room.hostSocketId === socket.id) {
			io.to(code).emit("room:closed");
			rooms.delete(code);
			return;
		}
		const player = room.players.get(socket.id);
		if (!player) return;
		if (room.started) {
			player.connected = false;
		} else {
			room.players.delete(socket.id);
		}
		io.to(code).emit("room:update", roomStatus(room));
	});
});

httpServer.listen(port, "0.0.0.0", () => {
	console.log(`Game 5 Detik berjalan pada port ${port}`);
	console.log(`Buka http://localhost:${port} di perangkat ini.`);
	console.log("Untuk perangkat lain di Wi-Fi yang sama, buka http://<IP-komputer-ini>:" + port);
});