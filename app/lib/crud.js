var mongodb = require('mongodb');
var _ = require('lodash');
var vow = require('vow');
var vowFs = require('vow-fs');
var inherits = require('util').inherits;

var Middleware = require('../models/middleware');
var util = require('./util');


var Crud = function (db, conf) {
	var crud = this;
	crud.db = db;
	crud.conf = conf;
	var schemas = conf.editableSchemas;

	crud.callbacks = {};
	crud.permissions = {};
	crud.schemas = {};

	for (var schemaName in schemas) {
		crud.callbacks[schemaName] = function (op, result) {
			this.emit(schemaName + ':' + op, result);
		}

		crud.permissions[schemaName] = (function (collectionName) {
			return function (op, input, user) {
				return new vow.Promise(function (resolve, reject) {
					if (user.permission(collectionName + ' all all') ||
						user.permission(collectionName + ' ' + op + ' all') ||
						user.permission(collectionName + ' all his') && crud._getSchemaOwnerField(collectionName, function (ownerField) {
							input.data[ownerField] = user._id.toString();
							input.where[ownerField] = user._id.toString();
						}) ||
						user.permission(collectionName + ' ' + op + ' his') && crud._getSchemaOwnerField(collectionName, function (ownerField) {
							input.data[ownerField] = user._id.toString();
							input.where[ownerField] = user._id.toString();
						})) {
						resolve();
					} else {
						reject();
					}
				});
			}
		})(schemaName);

		crud.schemas[schemaName] = (function (schemaName) {
			var schema = false;
			try {
				if (schemas.hasOwnProperty(schemaName)) {
					if (schemas[schemaName].hasOwnProperty('path')) {
						schema = require(conf.projectPath + schemas[schemaName].path);
					} else {
						schema = require('../../static/schemas/' + schemaName);
					}
				} else {

				}
			} catch (e) {
				console.log(e);
			}
			return schema;
		})(schemaName);
	}

	crud.middleware = new Middleware();
}

inherits(Crud, require('events').EventEmitter);


/**
 *
 * @param name {string}
 * @param successCb {Function}
 * @returns {boolean}
 */
Crud.prototype._getSchemaOwnerField = function (name, successCb) {
	var schema = this.schemas[name];
	if (schema) {
		if (schema.hasOwnProperty('ownerField')) {
			successCb(schema.ownerField);
			return true;
		}
	}
	return false;
};

/**
 * проверка на то, файл ли к нам пришёл в строке (она должна быть base64 файла, а если нет, то это не файл)
 *
 * @param str
 * @returns {boolean}
 */
Crud.prototype._isFile = function (str) {
	if (!str) {
		return false;
	}
	var a = str.substr(0, 5);
	if (a.indexOf('data:') != -1) {
		return true;
	} else {
		return false;
	}
};

/**
 * возвращает промис на сохранение файлового поля (оно приходит как массив, ведь можно несколько файлов залить через один инпут)
 *
 * @param schemaPart часть схемы (схема конкретного поля)
 * @param input само поле
 * @returns {vow.Promise}
 */
Crud.prototype._saveFilePromise = function (schemaPart, input) {
	var crud = this;
	return new vow.Promise(function (resolve, reject, notify) {
		var promises = [];
		for (var i = 0; i < input.length; ++i) {
			if (crud._isFile(input[i])) {
				var matches = input[i].split(';base64,');
				var data = matches[1];
				var mime = matches[0].replace('data:', '');
				var storage = crud.conf.fileUpload.storages[schemaPart.storage];

				if (_.contains(storage.mimes, mime)) {
					var buf = new Buffer(data, 'base64');
					var fileName = require('crypto').createHash('sha512').update(data + (new Date()).valueOf()).digest("hex") + '.' + crud.conf.fileUpload.mimes[mime];

					var filePath = [storage.path, fileName].join('/');
					var filePathWrite = [crud.conf.staticPath, storage.path, fileName].join('/');
					promises.push(vowFs.write(filePathWrite, buf));
					input[i] = filePath;
				} else {
					input[i] = null;
					var promise = new vow.Promise(function (resolve, reject, notify) {
						reject('mime type incorrect');
					});
					promises.push(promise);
				}
			} else {
				var promise = new vow.Promise(function (resolve, reject, notify) {
					resolve('not changed(sended url of file) or not base64 of file');
				});
				promises.push(promise);
			}
		}
		vow.allResolved(promises).then(function (result) {
			resolve(result);
		});
	});
};

/**
 * функция, которая готовит из объекта и его схемы массив из промисов на сохранение файлов, которые к нам пришли в base64 в соответствущих схеме полях
 *
 * @param schema полная схема объекта
 * @param obj весь объект
 * @returns {Array} массив промисов
 */

Crud.prototype._prepareFilesPromises = function (schema, obj) {
	var crud = this;
	var promises = [];
	for (var fieldName in schema.properties) {
		//console.log('fieldName', fieldName, 'type', schema.properties[fieldName].type);
		if (obj.hasOwnProperty(fieldName)) {
			if (//если просто файловое поле
			schema.properties[fieldName].widget == 'base64File'
			) {

				obj[fieldName] = _.compact(obj[fieldName]);
				promises.push(crud._saveFilePromise(schema.properties[fieldName], obj[fieldName]));

			} else if (//если массив из простых файловых полей
			schema.properties[fieldName].type == 'array' &&
			schema.properties[fieldName].items.widget == 'base64File'
			) {

				obj[fieldName].forEach(function (item, i) {
					item = _.compact(item);
					obj[fieldName][i] = item.length ? item : false
				});
				obj[fieldName] = _.compact(obj[fieldName]);
				obj[fieldName].forEach(function (item, i) {
					promises.push(crud._saveFilePromise(schema.properties[fieldName].items, item));
				});

			} else if (//если файловое поле часть объекта
			schema.properties[fieldName].type == 'object'
			) {

				crud._prepareFilesPromises(schema.properties[fieldName], obj[fieldName]).forEach(function (promise) {//рекурсия чтобы это файловое поле было как простое файловое поле
					promises.push(promise);
				});

			} else if (//если массив из объектов, в которых файловые поля
			schema.properties[fieldName].type == 'array'
			) {

				obj[fieldName] = _.compact(obj[fieldName]);
				obj[fieldName].forEach(function (item, i) {
					crud._prepareFilesPromises(schema.properties[fieldName].items, item).forEach(function (promise) {//рекурсия чтобы каждое файловое поле было как часть объекта
						promises.push(promise);
					});
				});

			}
		}
	}
	return promises;
};

/**
 * сохраняет файлы из obj в соответствии с его schema и выполняет callback
 * @param schema полная схема объекта
 * @param obj весь объект
 * @param callback
 */
Crud.prototype._prepareFiles = function (schema, obj, callback) {
	var crud = this;
	if (schema) {
		vow.allResolved(crud._prepareFilesPromises(schema, obj)).then(function (result) {
			callback(result);
		});
	} else {
		callback([]);
	}
};


Crud.prototype.create = function (collectionName, data, user) {
	var crud = this;
	return new vow.Promise(function (resolve, reject) {
		crud.permissions[collectionName]('create', {data: data}, user).then(function () {
			var schema = crud.schemas[collectionName];
			if (schema) {
				if (data instanceof Array) {
					data.forEach(function (row, i) {
						data[i] = util.forceSchema(schema, data[i]);
					});
					data = _.compact(data);
				} else {
					data = util.forceSchema(schema, data);
				}
			}
			crud._prepareFiles(schema, data, function (result) {
				if (data.hasOwnProperty('_id')) {
					delete data._id;
				}
				crud.db.collection(collectionName).insert(data, function (err, result) {
					if (err) {
						reject({
							error: err
						});
					} else {
						crud.callbacks[collectionName].call(crud, 'create', result[0]);
						resolve(result[0]);
					}
				});
			});
		}, function () {
			reject({
				error: 'not allowed'
			});
		});
	});
};

Crud.prototype.read = function (collectionName, where, user) {
	var crud = this;
	return new vow.Promise(function (resolve, reject) {
		crud.permissions[collectionName]('read', {where: where}, user).then(function () {
			if (where.hasOwnProperty('_id')) {
				if (where._id instanceof Object) {
					if (where._id.hasOwnProperty('$in')) {
						where._id.$in.forEach(function (item, i) {
							where._id.$in[i] = new mongodb.ObjectID(item.toString());
						});
					}
				} else {
					where._id = new mongodb.ObjectID(where._id.toString());
				}

			}
			var fields = [];
			if (where.hasOwnProperty('fields')) {
				fields = where.fields;
				delete where.fields;
			}
			var optionKeys = ['skip', 'limit', 'sort'];
			var options = {};
			optionKeys.forEach(function (key) {
				options[key] = where[key];
				delete where[key];
			});
			crud.db.collection(collectionName).find(where, fields, options).toArray(function (err, result) {
				if (err) {
					reject({
						error: err
					});
				} else {
					crud.callbacks[collectionName].call(crud, 'read', result);
					resolve(result);
				}
			});
		}, function () {
			reject({
				error: 'not allowed'
			});
		});
	});
};

Crud.prototype.update = function (collectionName, _id, data, user) {
	var crud = this;
	return new vow.Promise(function (resolve, reject) {
		var where = {
			_id: new mongodb.ObjectID(_id)
		};
		crud.permissions[collectionName]('update', {where: where, data: data}, user).then(function () {
			var schema = crud.schemas[collectionName];
			if (schema) {
				data = util.forceSchema(schema, data);
			}
			crud._prepareFiles(schema, data, function (result) {
				if (data.hasOwnProperty('_id')) {
					delete data._id;
				}
				crud.db.collection(collectionName).update(where, {
					"$set": data
				}, function (err, results) {
					if (err) {
						reject({
							error: err
						});
					} else {
						data._id = _id;
						crud.callbacks[collectionName].call(crud, 'update', data);
						resolve(data);
					}
				});
			});
		}, function () {
			reject({
				error: 'not allowed'
			});
		});
	});
};

Crud.prototype.delete = function (collectionName, _id, user) {
	var crud = this;
	return new vow.Promise(function (resolve, reject) {
		var where = {
			_id: new mongodb.ObjectID(_id)
		};
		crud.permissions[collectionName]('delete', {where: where}, user).then(function () {
			crud.db.collection(collectionName).remove(where, function (err, numRemoved) {
				if (err) {
					reject({
						error: err
					});
				} else {
					crud.callbacks[collectionName].call(crud, 'delete', where._id.toString());
					resolve(numRemoved);
				}
			});
		}, function () {
			reject({
				error: 'not allowed'
			});
		});
	});
};

module.exports = Crud;
