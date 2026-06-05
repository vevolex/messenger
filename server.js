const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 📦 VERİTABANI BAĞLANTISI VE TABLO OLUŞTURMA
const db = new sqlite3.Database('./chat.db', (err) => {
    if (err) console.error("Veritabanı hatası:", err.message);
    console.log('📦 SQLite veritabanı aktif.');
});

// Mesajlar Tablosu
db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room TEXT,
    user TEXT,
    message TEXT,
    time TEXT
)`);

// Kullanıcılar Tablosu (YENİ)
db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT
)`);

app.use(express.static(path.join(__dirname, 'public')));

function getRoomCount(roomName) {
    const room = io.sockets.adapter.rooms.get(roomName);
    return room ? room.size : 0;
}

function getRoomUsers(roomName) {
    const room = io.sockets.adapter.rooms.get(roomName);
    if (!room) return [];
    let users = [];
    for (const socketId of room) {
        const clientSocket = io.sockets.sockets.get(socketId);
        if (clientSocket && clientSocket.username) {
            users.push(clientSocket.username);
        }
    }
    return [...new Set(users)];
}

// Aktif odaları bulma (YENİ)
function getActiveRooms() {
    const rooms = [];
    for (let [id, sockets] of io.sockets.adapter.rooms) {
        if (!io.sockets.adapter.sids.get(id)) {
            rooms.push({ name: id, count: sockets.size });
        }
    }
    return rooms;
}

io.on('connection', (socket) => {
    
    // --- ÜYELİK SİSTEMİ (YENİ) ---
    socket.on('register', (data) => {
        db.run(`INSERT INTO users (username, password) VALUES (?, ?)`, [data.username, data.password], function(err) {
            if (err) {
                socket.emit('auth_result', { success: false, msg: 'Bu kullanıcı adı zaten alınmış!' });
            } else {
                socket.emit('auth_result', { success: true, isRegister: true, msg: 'Kayıt başarılı! Giriş yapabilirsiniz.' });
            }
        });
    });

    socket.on('login', (data) => {
        db.get(`SELECT * FROM users WHERE username = ? AND password = ?`, [data.username, data.password], (err, row) => {
            if (row) {
                socket.username = row.username;
                socket.emit('auth_result', { success: true, isLogin: true, username: row.username });
            } else {
                socket.emit('auth_result', { success: false, msg: 'Kullanıcı adı veya şifre hatalı!' });
            }
        });
    });

    // Lobi için aktif odaları gönder (YENİ)
    socket.on('get_lobbies', () => {
        socket.emit('lobby_list', getActiveRooms());
    });

    // --- ODA VE MESAJ SİSTEMİ ---
    socket.on('join_room', (data) => {
        socket.join(data.room);
        socket.room = data.room;
        
        io.to(data.room).emit('system_message', `${socket.username} sohbete katıldı.`);
        io.to(data.room).emit('room_stats', { count: getRoomCount(data.room), users: getRoomUsers(data.room) });
        io.emit('lobby_list', getActiveRooms()); // Tüm lobilere aktif oda güncellemesi yap
        
        db.all(`SELECT id, user, message, time FROM messages WHERE room = ? ORDER BY id ASC`, [data.room], (err, rows) => {
            if (err) return console.log(err.message);
            socket.emit('message_history', rows);
        });
    });

    socket.on('leave_room', () => {
        if (socket.username && socket.room) {
            const oda = socket.room;
            socket.leave(oda);
            io.to(oda).emit('system_message', `${socket.username} odadan ayrıldı.`);
            io.to(oda).emit('room_stats', { count: getRoomCount(oda), users: getRoomUsers(oda) });
            socket.room = null;
            io.emit('lobby_list', getActiveRooms());
        }
    });

    socket.on('send_message', (data) => {
        const simdi = new Date();
        const saat = String(simdi.getHours()).padStart(2, '0');
        const dakika = String(simdi.getMinutes()).padStart(2, '0');
        const timeStr = `${saat}:${dakika}`;

        db.run(`INSERT INTO messages (room, user, message, time) VALUES (?, ?, ?, ?)`, 
            [socket.room, socket.username, data.message, timeStr], 
            function(err) {
                if (err) return console.log(err.message);
                const msgData = { id: this.lastID, user: socket.username, message: data.message, time: timeStr };
                io.to(socket.room).emit('receive_message', msgData);
            }
        );
    });

    // Mesaj Silme İşlemi (YENİ)
    socket.on('delete_message', (msgId) => {
        db.run(`DELETE FROM messages WHERE id = ? AND user = ? AND room = ?`, [msgId, socket.username, socket.room], function(err) {
            if (!err && this.changes > 0) {
                io.to(socket.room).emit('message_deleted', msgId);
            }
        });
    });

    socket.on('typing', (data) => {
        if(socket.room) socket.to(socket.room).emit('user_typing', { user: socket.username, isTyping: data.isTyping });
    });

    socket.on('disconnect', () => {
        if (socket.username && socket.room) {
            const oda = socket.room;
            io.to(oda).emit('system_message', `${socket.username} sohbetten ayrıldı.`);
            io.to(oda).emit('room_stats', { count: getRoomCount(oda), users: getRoomUsers(oda) });
            io.emit('lobby_list', getActiveRooms());
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Sunucu http://localhost:${PORT} adresinde çalışıyor`);
});