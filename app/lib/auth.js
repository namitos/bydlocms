var mongodb = require('mongodb');
var cookieParser = require('cookie-parser');

var User = require('../models/user');

module.exports = function (app) {

	var auth = {};
	auth.auth = function (username, password, done) {
		var conf = app.get('conf');
		password = require('crypto').createHash('sha512').update(password).digest("hex");
		app.db.collection('users').find({
			username: username,
			password: password
		}).toArray(function (err, result) {
			if (err) {
				done(err, null);
			} else {
				if (result.length) {
					console.log('user exists');
					done(null, new User(result[0], conf));
				} else {
					console.log('user not exists');
					done(null, null);
				}
			}
		});
	};

	auth.serialize = function (user, done) {
		done(null, user._id.toString());
	};

	auth.deserialize = function (id, done) {
		var conf = app.get('conf');
		app.db.collection('users').find({_id: new mongodb.ObjectID(id)}).toArray(function (err, result) {
			if (err) {
				done(err, null);
			} else {
				if (result.length) {
					done(null, new User(result[0], conf));
				} else {
					console.log('user not exists');
					done(null, null);
				}
			}
		});
	};
	auth.permissionsMiddleware = function (req, res, next) {
		var conf = app.get('conf');
		if (!req.hasOwnProperty('user')) {
			req.user = new User({roles: ['anon']}, conf);
		}
		var url = req.url.split('/');
		if (url[1] == 'admin') {
			if (req.user.permission('full access')) {
				next();
			} else {
				res.send(403, 'access denied');
			}
		} else {
			next();
		}
	};
	auth.ioUserMiddleware = function (socket, next) {
		var conf = app.get('conf');
		var req = {
			headers: {
				cookie: socket.handshake.headers.cookie || ''
			}
		};
		var cookies;
		cookieParser(conf.session.secret)(req, {}, function (err) {
			if (err) throw err;
			cookies = req.signedCookies || req.cookies;
		});
		app.sessionStore.get(cookies.session, function (err, session) {
			auth.deserialize(session.passport.user, function (msg, user) {
				socket.request.user = user;
				next();
			});
		});
	};
	return auth;
};