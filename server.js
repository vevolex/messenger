const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e7 }); 

const db = new sqlite3.Database('./chat.db', (err) => {
    if (err) console.error("Veritabanı hatası:", err.message);
    console.log('📦 SQLite veritabanı aktif.');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT, user TEXT, message TEXT, time TEXT, likes INTEGER DEFAULT 0, reply_to TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, bio TEXT, avatar_url TEXT, last_seen TEXT)`);
    
    // Eksik sütunları güvenli şekilde ekleme
    db.run(`ALTER TABLE users ADD COLUMN bio TEXT`, (err) => {});
    db.run(`ALTER TABLE users ADD COLUMN avatar_url TEXT`, (err) => {});
    db.run(`ALTER TABLE messages ADD COLUMN likes INTEGER DEFAULT 0`, (err) => {});
    db.run(`ALTER TABLE messages ADD COLUMN reply_to TEXT`, (err) => {});
    db.run(`ALTER TABLE users ADD COLUMN last_seen TEXT`, (err) => {});
});

app.use(express.static(path.join(__dirname, 'public')));

function getRoomUsers(roomName) {
    const room = io.sockets.adapter.rooms.get(roomName);
    if (!room) return [];
    let users = [];
    for (const socketId of room) {
        const clientSocket = io.sockets.sockets.get(socketId);
        if (clientSocket && clientSocket.username) users.push(clientSocket.username);
    }
    return [...new Set(users)];
}

function getActiveRooms() {
    const rooms = [];
    for (let [id, sockets] of io.sockets.adapter.rooms) {
        if (!io.sockets.adapter.sids.get(id)) rooms.push({ name: id, count: sockets.size });
    }
    return rooms;
}

io.on('connection', (socket) => {
    socket.on('register', (data) => {
        db.run(`INSERT INTO users (username, password, bio, avatar_url, last_seen) VALUES (?, ?, ?, ?, ?)`, 
        [data.username, data.password, 'Merhaba! Ben de buradayım.', '', 'Şu an aktif'], function(err) {
            if (err) socket.emit('auth_result', { success: false, msg: 'Bu kullanıcı adı zaten alınmış!' });
            else socket.emit('auth_result', { success: true, isRegister: true, msg: 'Kayıt başarılı! Giriş yapabilirsiniz.' });
        });
    });

    socket.on('login', (data) => {
        db.get(`SELECT * FROM users WHERE username = ? AND password = ?`, [data.username, data.password], (err, row) => {
            if (row) {
                socket.username = row.username;
                db.run(`UPDATE users SET last_seen = ? WHERE username = ?`, ['Şu an aktif', socket.username]);
                socket.emit('auth_result', { success: true, isLogin: true, username: row.username, bio: row.bio, avatar_url: row.avatar_url });
            } else {
                socket.emit('auth_result', { success: false, msg: 'Hatalı giriş!' });
            }
        });
    });

    socket.on('update_profile', (data) => {
        db.run(`UPDATE users SET bio = ?, avatar_url = ? WHERE username = ?`, [data.bio, data.avatar_url, socket.username]);
        io.emit('profile_updated', { username: socket.username, bio: data.bio, avatar_url: data.avatar_url });
    });

    socket.on('get_user_info', (username) => {
        db.get(`SELECT username, bio, avatar_url, last_seen FROM users WHERE username = ?`, [username], (err, row) => {
            if (row) socket.emit('user_info_result', row);
        });
    });

    socket.on('get_lobbies', () => {
        socket.emit('active_rooms', getActiveRooms());
    });

    socket.on('join_room', (roomName) => {
        if (socket.room) {
            socket.leave(socket.room);
            io.to(socket.room).emit('system_message', `👋 ${socket.username} odadan ayrıldı.`);
            io.to(socket.room).emit('room_users', getRoomUsers(socket.room));
        }
        socket.join(roomName);
        socket.room = roomName;
        io.to(roomName).emit('system_message', `🔥 ${socket.username} odaya katıldı!`);
        
        db.all(`SELECT * FROM messages WHERE room = ? ORDER BY id ASC`, [roomName], (err, rows) => {
            socket.emit('chat_history', rows || []);
            io.to(roomName).emit('room_users', getRoomUsers(roomName));
            io.emit('active_rooms', getActiveRooms());
        });
    });

    socket.on('chat_message', (data) => {
        const timeStr = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
        db.run(`INSERT INTO messages (room, user, message, time, likes, reply_to) VALUES (?, ?, ?, ?, 0, ?)`, 
        [socket.room, socket.username, data.message, timeStr, data.replyTo || null], function(err) {
            if (!err) {
                db.get(`SELECT avatar_url FROM users WHERE username = ?`, [socket.username], (err, row) => {
                    io.to(socket.room).emit('chat_message', { 
                        id: this.lastID, user: socket.username, message: data.message, time: timeStr, 
                        avatar_url: row ? row.avatar_url : '', likes: 0, reply_to: data.replyTo || null
                    });
                });
            }
        });
    });

    // YENİ: Neon Efektli Mesaj Beğenme (Like) Sistemi
    socket.on('like_message', (msgId) => {
        db.run(`UPDATE messages SET likes = likes + 1 WHERE id = ?`, [msgId], function(err) {
            if (!err) {
                db.get(`SELECT likes FROM messages WHERE id = ?`, [msgId], (err, row) => {
                    if(row) io.to(socket.room).emit('message_liked', { id: msgId, likes: row.likes });
                });
            }
        });
    });

    socket.on('delete_message', (msgId) => {
        db.run(`DELETE FROM messages WHERE id = ? AND user = ? AND room = ?`, [msgId, socket.username, socket.room], function(err) {
            if (!err && this.changes > 0) io.to(socket.room).emit('message_deleted', msgId);
        });
    });

    socket.on('typing', (data) => {
        if(socket.room) socket.to(socket.room).emit('user_typing', { user: socket.username, isTyping: data.isTyping });
    });

    socket.on('disconnect', () => {
        if(socket.username) {
            const timeStr = new Date().toLocaleString('tr-TR');
            db.run(`UPDATE users SET last_seen = ? WHERE username = ?`, [timeStr, socket.username]);
        }
        if (socket.username && socket.room) {
            const oda = socket.room;
            io.to(oda).emit('system_message', `🔌 ${socket.username} bağlantıyı kesti.`);
            io.to(oda).emit('room_users', getRoomUsers(oda));
            setTimeout(() => io.emit('active_rooms', getActiveRooms()), 1000);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Sunucu çalışıyor: http://localhost:${PORT}`);
});