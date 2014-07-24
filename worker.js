module.exports = function (conf, modifyApp) {
	var express = require('express');
	var app = express();
	var server = require('http').createServer(app);

	app.io = require('socket.io')(server);

	var session = require('express-session');
	var RedisStore = require('connect-redis')(session);
	var passport = require('passport');
	var LocalStrategy = require('passport-local').Strategy;
	var mongodb = require('mongodb');
	var fs = require('fs');
	var vow = require('vow');
	var vowFs = require('vow-fs');
	var drev = require('drev');

	var User = require('./app/models/user');

	var sessionConfiguration = {
		store: new RedisStore({ host: conf.session.redis.host, port: conf.session.redis.port, ttl: 604800 }),
		secret: conf.session.secret,
		key: 'session',
		cookie: { maxAge: 604800000 },
		fail: function (data, accept) {
			accept(null, true);
		},
		success: function (data, accept) {
			accept(null, true);
		}
	};

	app.response.__proto__.renderPage = function (template, parameters) {
		if (!parameters) {
			parameters = {};
		}
		var res = this;
		var req = res.req;
		var url = req.url.split('/');
		parameters.user = req.hasOwnProperty('user') ? req.user : false;
		parameters.conf = conf;
		res.render(template, parameters, function (err, html) {
			res.render(url[1] == 'admin' ? app.get('adminViewsPath') + '/admin/page' : 'page', {
				html: html,
				user: req.hasOwnProperty('user') ? req.user : false,
				conf: conf,
				title: parameters.hasOwnProperty('title') ? parameters.title : ''
			});
		});
	}

	app.set('conf', conf);
	app.set('corePath', __dirname);
	app.set('env', process.env.NODE_ENV);
	app.set('views', conf.viewsPath);
	app.set('view cache', conf.viewCache);
	app.engine('ejs', require('consolidate').lodash);
	app.set('view engine', 'ejs');
	app.set('adminViewsPath', __dirname + '/static/views');


	var middleWares = [
		{
			key: 'bodyParser',
			fn: require('body-parser')({ limit: '500mb'})
		},
		{
			key: 'cookieParser',
			fn: require('cookie-parser')()
		},
		{
			key: 'session',
			fn: session(sessionConfiguration)
		},
		{
			key: 'passportInitialize',
			fn: passport.initialize()
		},
		{
			key: 'passportSession',
			fn: passport.session()
		},
		{
			key: 'coreStatic',
			fn: express.static(__dirname + '/static'),
			url: '/core'
		},
		{
			key: 'static',
			fn: express.static(conf.staticPath),
			url: '/static'
		},
		{
			key: 'permissions',
			fn: function (req, res, next) {
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
			}
		},
		{
			key: 'pages',
			fn: function (req, res, next) {
				var db = app.get('db');
				db.collection('pages').find({
					route: req.url.split('?')[0]
				}).toArray(function (err, result) {
					if (result.length > 0) {
						res.renderPage(app.get('adminViewsPath') + '/staticpage', {
							title: result[0].title,
							page: result[0]
						});
					} else {
						next();
					}
				});
			}
		}
	];

	if (modifyApp) {
		modifyApp(app, middleWares);
	}

	middleWares.forEach(function (obj) {
		if (obj.hasOwnProperty('url')) {
			app.use(obj.url, obj.fn);
		} else {
			app.use(obj.fn);
		}
	});

	function mongoConnectPromise(connectionString) {
		return new vow.Promise(function (resolve, reject, notify) {
			var MongoClient = mongodb.MongoClient;
			MongoClient.connect(connectionString, function (err, db) {
				if (err) {
					console.log(err);
					reject(err);
				} else {
					resolve(db);
				}
			});
		});
	}

	function routesPromise(path) {
		return new vow.Promise(function (resolve, reject, notify) {
			fs.readdir(path, function (err, files) {
				if (err) {
					console.log(err);
					reject(err);
				} else {
					files.forEach(function (file) {
						require(path + '/' + file)(app);
					});
					resolve(files);
				}
			});
		});
	}

	var promises = {
		db: mongoConnectPromise(conf.mongoConnect),
		routes: routesPromise(__dirname + '/app/routes'),
		projectInfo: vowFs.read('./package.json', 'utf8')
	};
	if (conf.hasOwnProperty('routesPath')) {
		promises.routesPath = routesPromise(conf.routesPath);
	}


	vow.all(promises).then(function (result) {
		var db = result.db;
		app.set('db', db);

		passport.use(new LocalStrategy(
			function (username, password, done) {
				//console.log('trying', username, password);
				password = require('crypto').createHash('sha512').update(password).digest("hex");
				db.collection('users').find({username: username, password: password}).toArray(function (err, result) {
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
			}
		));
		passport.serializeUser(function (user, done) {
			//console.log('user serialize', user);
			done(null, user._id.toString());
		});
		passport.deserializeUser(function (id, done) {
			//console.log('user deserialize', id);
			db.collection('users').find({_id: new mongodb.ObjectID(id)}).toArray(function (err, result) {
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
		});

		app.set('projectInfo', JSON.parse(result.projectInfo));

		drev.start(conf.session.redis.host, conf.session.redis.port);

		server.listen(process.env.port, function () {
		});
	});
};

