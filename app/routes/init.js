var crypto = require('crypto');

module.exports = function(app){
	if (app.get('env') != 'production') {
		app.get('/init', function(req, res){
			var db = app.get('db');
			db.collection('users').remove(function(){
				db.collection('users').insert({
					username: 'admin',
					password:crypto.createHash('sha512').update('123').digest("hex"),
					roles:['admin']
				}, function(err, docs){
					res.send(docs);
				});
			});

		});
	}
};