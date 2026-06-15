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
});

app.use(express.static(path.join(__dirname, 'public')));

// YENİ: Şifreli Odalar ve Sabit Mesajlar İçin Bellek
let roomPasswords = {};
let pinnedMessages = {};

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

    socket.on('get_lobbies', () => {
        db.all(`SELECT room as name, COUNT(DISTINCT user) as count FROM messages GROUP BY room ORDER BY count DESC LIMIT 15`, [], (err, rows) => {
            socket.emit('update_lobbies', rows || []);
        });
    });

    socket.on('joinRoom', (data) => {
        const room = data.room;
        const pass = data.password;

        // YENİ: Oda Şifresi Kontrolü
        if (roomPasswords[room] && roomPasswords[room] !== pass) {
            return socket.emit('room_error', "Yanlış oda şifresi!");
        }
        if (data.setPass) roomPasswords[room] = data.setPass;

        if(socket.room) socket.leave(socket.room);
        socket.join(room);
        socket.room = room;
        
        db.all(`SELECT * FROM messages WHERE room = ? ORDER BY id ASC`, [room], (err, rows) => {
            socket.emit('load_messages', rows || []);
            io.to(room).emit('system_message', `👋 ${socket.username} odaya katıldı.`);
            
            // YENİ: Odaya girince sabitlenmiş mesajı göster
            if (pinnedMessages[room]) socket.emit('message_pinned', pinnedMessages[room]);
            
            const clients = io.sockets.adapter.rooms.get(room);
            if (clients) {
                const users = Array.from(clients).map(id => io.sockets.sockets.get(id).username);
                io.to(room).emit('room_users', [...new Set(users)]);
            }
        });
    });

    socket.on('leaveRoom', (room) => {
        socket.leave(room);
        io.to(room).emit('system_message', `🚪 ${socket.username} odadan ayrıldı.`);
        const clients = io.sockets.adapter.rooms.get(room);
        if (clients) {
            const users = Array.from(clients).map(id => io.sockets.sockets.get(id).username);
            io.to(room).emit('room_users', [...new Set(users)]);
        }
    });

    socket.on('send_message', (data) => {
        const time = new Date().toLocaleTimeString('tr-TR', {hour:'2-digit', minute:'2-digit'});
        
        // YENİ: Kaybolan (Flash) mesaj veritabanına kaydedilmez, anlık uçar
        if (data.isFlash) {
            io.to(data.room).emit('receive_message', { id: Date.now(), room: data.room, user: data.user, message: data.message, time: time, isFlash: true });
            return;
        }

        db.run(`INSERT INTO messages (room, user, message, time) VALUES (?, ?, ?, ?)`, 
        [data.room, data.user, data.message, time], function(err) {
            if (!err) io.to(data.room).emit('receive_message', { id: this.lastID, room: data.room, user: data.user, message: data.message, time: time, likes: 0 });
        });
    });

    // YENİ: Sabit Mesaj, Silme ve Beğenme İşlemleri
    socket.on('pin_message', (text) => {
        pinnedMessages[socket.room] = text;
        io.to(socket.room).emit('message_pinned', text);
    });

    socket.on('delete_message', (id) => {
        db.run(`DELETE FROM messages WHERE id = ? AND user = ?`, [id, socket.username], function() { 
            if(this.changes > 0) io.to(socket.room).emit('message_deleted', id); 
        });
    });

    socket.on('like_message', (id) => {
        db.run(`UPDATE messages SET likes = likes + 1 WHERE id = ?`, [id], function() {
            db.get(`SELECT likes FROM messages WHERE id = ?`, [id], (e, row) => {
                if (row) io.to(socket.room).emit('message_liked', { id: id, likes: row.likes });
            });
        });
    });

    socket.on('typing', (data) => {
        if(socket.room) socket.to(socket.room).emit('user_typing', { user: socket.username, isTyping: data.isTyping });
    });

    socket.on('get_user_profile', (username) => {
        db.get(`SELECT bio, last_seen, avatar_url FROM users WHERE username = ?`, [username], (err, row) => {
            if (row) socket.emit('show_user_profile', { username: username, ...row });
        });
    });

    socket.on('disconnect', () => {
        if (socket.username) {
            db.run(`UPDATE users SET last_seen = ? WHERE username = ?`, [new Date().toLocaleString('tr-TR'), socket.username]);
            if (socket.room) {
                io.to(socket.room).emit('system_message', `🔌 ${socket.username} bağlantıyı kesti.`);
                const clients = io.sockets.adapter.rooms.get(socket.room);
                if (clients) {
                    const users = Array.from(clients).map(id => io.sockets.sockets.get(id).username);
                    io.to(socket.room).emit('room_users', [...new Set(users)]);
                }
            }
        }
    });
});

server.listen(3000, () => console.log('🚀 Sunucu http://localhost:3000 aktif!'));