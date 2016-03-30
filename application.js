/*************************************************************************************
 * The MIT License (MIT)                                                             *
 * <p/>                                                                              *
 * Copyright (c) 2016 Bertrand Martel                                                *
 * <p/>                                                                              *
 * Permission is hereby granted, free of charge, to any person obtaining a copy      *
 * of this software and associated documentation files (the "Software"), to deal     *
 * in the Software without restriction, including without limitation the rights      *
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell         *
 * copies of the Software, and to permit persons to whom the Software is             *
 * furnished to do so, subject to the following conditions:                          *
 * <p/>                                                                              *
 * The above copyright notice and this permission notice shall be included in        *
 * all copies or substantial portions of the Software.                               *
 * <p/>                                                                              *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR        *
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,          *
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE       *
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER            *
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,     *
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN         *
 * THE SOFTWARE.                                                                     *
 */

'use strict';

/**
 * Module dependencies.
 * @private
 */
var http = require("http");
var url = require("url");
var async = require('async');
var fs = require("fs");
var tar = require('tar-fs');
var gunzip = require('gunzip-maybe');
var colors = require('colors');
var time = require('node-tictoc');
var cluster = require('cluster');

/**
 * set color theme for log
 */
colors.setTheme({
	silly: 'rainbow',
	input: 'grey',
	verbose: 'cyan',
	prompt: 'grey',
	info: 'green',
	data: 'grey',
	help: 'cyan',
	warn: 'yellow',
	debug: 'blue',
	error: 'red'
});

/**
 * unarchive gzip + untar
 *
 * @param {string} path to tarball to unzip + untar
 * @param {string} the directory where tarball unarchived content will be put
 */
function untar(file, outputDir) {
	file.pipe(gunzip()).pipe(tar.extract(outputDir)).on('error', function(e) {
		console.log(colors.error(file.path + " : " + e));
	});
}

/**
 * define if download task has already been called and is not finished yet
 * @private
 */
var downloading = false;

/**
 * counter for tarball entries
 * @private
 */
var count = 0;

/**
 * number of attempts before aborting download
 * @private
 */
var MAX_RETRY = 2;

/**
 * server port
 * @private
 */
var PORT = 8000;

/**
 * number of simultaneous download
 * @private
 */
var DEFAULT_SIMULTANEOUS_DL = 25;

/**
 * http request timeout for each individual request
 * @private
 */
var DEFAULT_REQUEST_TIMEOUT = 5000;

/**
 * default temporary directory where tarball will be copied before piped to output directory
 * @private
 */
var DEFAULT_DIRECTORY = "/tmp";

/** 
 * array containing request retry with file url as key and number of retry for this url as value
 * @private
 */
var retryMap = new Array();

/**
 * total number of file to download
 * @private
 */
var totalLength = 0;

/**
 * remove duplicate in list of url
 *
 * @param files list of url of tarball to download
 * @param files[i].url file url to download
 */
function filterDuplicates(files) {

	var filesNoDuplicate = {};

	for (var i = 0, len = files.length; i < len; i++)
		filesNoDuplicate[files[i]['url']] = files[i];

	files = new Array();
	for (var key in filesNoDuplicate)
		files.push(filesNoDuplicate[key]);
}

/**
 * display a verbose log and emit on socket IO
 *
 * @param data {string} log entry
 */
function log_verbose(data) {
	io.sockets.emit('log_verbose', "[" + new Date().toISOString() + "] " + data);
	console.log(colors.verbose("[" + new Date().toISOString() + "] " + data));
}

/**
 * display an error log and emit on socket IO
 *
 * @param data {string} log entry
 */
function log_error(data) {
	io.sockets.emit('log_error', "[" + new Date().toISOString() + "] " + data);
	console.log(colors.error("[" + new Date().toISOString() + "] " + data));
}

/**
 * display an info log and emit on socket IO
 *
 * @param data {string} log entry
 */
function log_info(data) {
	io.sockets.emit('log_info', "[" + new Date().toISOString() + "] " + data);
	console.log(colors.info("[" + new Date().toISOString() + "] " + data));
}

/**
 * add file entry to retry array if retry value for this url entry is < MAX_RETRY
 *
 * @param list list of url to download
 * @param file file entry to decide if we retry or not
 * @param filename contain only filename of file
 */
function retry(list, file, filename) {

	var retry;
	if (file.url in retryMap) {
		retry = retryMap[file.url];
	} else {
		retry = 1;
	}
	if (retry < MAX_RETRY) {
		retryMap[file.url] = retry + 1;
		list.push({
			url: file.url,
			outputDirectory: file.outputDirectory
		});
		log_error("[" + count + "/" + totalLength + "] file " + filename + " failed. Retrying : " + retry + "/" + MAX_RETRY);
		return true;
	} else {
		log_error("[" + count + "/" + totalLength + "] file " + filename + " failed. Aborting...");
		return false;
	}
}

/**
 * download task used to create a web worker to perform untar-ungzip tasks while master is downloading
 *
 * @param files list of url to download
 * @param simultaneousDownload define number of simultaneous download that can occur
 * @param attemptsNumber number of maximum attemp for each request
 * @param requestTimeout http request timeout value for each request
 */
function download(files, simultaneousDownload, attemptsNumber, requestTimeout) {

	downloading = true; // download task is busy

	//check max retry value
	if (attemptsNumber >= 0) {
		MAX_RETRY = attemptsNumber;
	}

	//check request timeout value
	var requestTimeoutVal = DEFAULT_REQUEST_TIMEOUT;
	if (requestTimeout > 0) {
		requestTimeoutVal = requestTimeout;
	}

	//check simultaneous download value
	var simultaneousDl = DEFAULT_SIMULTANEOUS_DL;
	if (simultaneousDownload >= 1) {
		simultaneousDl = simultaneousDownload;
	}

	//define cluster online callback
	var clusterCallback;

	//remove duplicate from url list
	filterDuplicates(files);

	//initialize number of url to iterate
	totalLength = files.length;

	//initialize download processed counter
	count = 0;

	//create a new web worker
	var worker = cluster.fork();

	time.tic();

	//define message callback for this new web worker
	worker.on('message', function(message) {

		if (message.type === 'untar') {

			count++;
			log_verbose("[" + count + "/" + totalLength + "] file " + message.data.filename + " was processed successfully");

			if (count == totalLength) {

				log_verbose('removing worker');
				time.toc();
				//worker.send({type: 'shutdown', from: 'master'});
				downloading = false;
				worker.kill('SIGKILL');
				cluster.removeListener('online', clusterCallback, null);
			}
		} else if (message.type === 'untar_fail') {

			log_error("[" + count + "/" + totalLength + "] file " + message.data.filename + " failed : " + message.error + ". Retrying...");
			files.push({
				url: message.data.filename,
				outputDirectory: message.data.outputDir
			});
		}
	});

	//define cluster online callback
	clusterCallback = function(worker) {

		log_info('Worker ' + worker.process.pid + ' is online');

		//iterate through all url with the specified simultaneous download value
		async.eachLimit(files, simultaneousDl, function(file, callback) {

			try {
				var filename = url.parse(file.url).pathname.split("/").pop();

				var options = {
					host: url.parse(file.url).hostname,
					path: url.parse(file.url).pathname,
					method: 'GET'
				};

				//listen to http request
				var listener = function(response) {

					var downloadfile = fs.createWriteStream(DEFAULT_DIRECTORY + "/" + filename, {
						'flags': 'w'
					});

					//maange chunked data
					response.on('data', function(chunk) {
						downloadfile.write(chunk, {
							'encoding': 'binary'
						});
					});

					//untar + ungzip file when download is done
					response.on("end", function() {

						downloadfile.end();
						worker.send({
							type: 'untar',
							from: 'master',
							data: {
								filename: DEFAULT_DIRECTORY + "/" + filename,
								outputDir: file.outputDirectory
							}
						});
						//go to next download
						callback();
					});

					response.on("error", function(err) {
						log_error("response error " + err);
					});

				};

				var req = http.request(options, listener);

				//manage http error
				req.on('error', function(e) {

					//define if this request has to be retried or not
					var isRetry = retry(files, file, filename);

					if (!isRetry) {
						//mark this url as processed <=> increment counter (TODO: we could here add this url to an error file optionnally)
						count++;
						if (count == totalLength) {
							//all url have been processed, now remove web worker 
							log_verbose('removing worker');
							time.toc();
							//worker.send({type: 'shutdown', from: 'master'});
							worker.kill('SIGKILL');
							//remove cluster listener to avoid duplicates
							cluster.removeListener('online', clusterCallback, null);
							downloading = false;
						}
					}
					callback();
				});

				//timeout is for information only (TODO:track error relative to timeout issue)
				req.on('timeout', function() {
					log_error('timeout');
					req.abort();
				});

				//set http request timeout
				req.setTimeout(requestTimeoutVal);

				req.end();

			} catch (ex) {
				log_error(ex);
				fs.appendFile('errors.txt', 'async task failure : ' + ex, function(err) {
					callback();
				});
			}
		});
	};

	//define cluster callback called when a worker is online
	cluster.on('online', clusterCallback, null);

};

if (cluster.isMaster) {

	//This is the cluster master with http server + socket IO

	var express = require('express'),
		app = express();
	var http = require('http');
	var server = http.createServer(app);
	var io = require('socket.io').listen(server);
	var bodyParser = require('body-parser');

	app.use(bodyParser.urlencoded({
		extended: true
	}));
	app.use(bodyParser.json());

	// startDownload api used to start download task if not already running
	app.post('/startDownload', function(req, res) {
		log_verbose("api called : startDownload")
		if (!downloading) {
			try {
				var fileJson = JSON.parse(req.body.files); // parse json url list
				var simultaneousDownload = req.body.simultaneous_download;
				var attemptsNumber = req.body.attempts_number;
				var requestTimeout = req.body.requestTimeout;
				if (fileJson instanceof Array) {
					download(fileJson, simultaneousDownload, attemptsNumber, requestTimeout);
				} else {
					log_error("invalid json format");
					res.sendStatus(500);
					return;
				}
				res.sendStatus(200);
			} catch (e) {
				log_error("invalid json format");
				res.sendStatus(500);
			}
		} else {
			log_error("already downloading...");
			res.sendStatus(500);
		}
	});

	app.use("/", express.static(__dirname + '/'));

	server.listen(PORT, function() {
		log_info('Process ' + process.pid + ' is listening to all incoming requests')
	});

	log_info("Server listening on port " + PORT);

	//this is socket IO part
	io.sockets.on('connection', function(socket) {

		log_verbose("client has connected");

		socket.on('message', function(data) {
			log_verbose("new message : " + data);
		});
		socket.on('disconnect', function() {
			log_verbose("client has disconnected");
		});
	});

} else {

	// This is the web worker created by download task used to untar + ungzip downloaded files

	process.on('message', function(message) {

		if (message.type === 'untar') {

			//get file stream to be read from
			var file = fs.createReadStream(message.data.filename);

			//manage error cases (TODO: maybe delete the file if exists on error)
			file.on('error', function(err) {
				process.send({
					type: 'untar_fail',
					from: 'Worker ' + process.pid,
					data: {
						filename: message.data.filename,
						outputDir: message.data.outputDirectory,
						error: "" + err
					}
				});
			});

			//manage end of untar+gzip task + delete the file
			file.on('end', function() {
				fs.unlink(message.data.filename, function() {
					process.send({
						type: 'untar',
						from: 'Worker ' + process.pid,
						data: message.data
					});
				});
			});

			//untar+ungzip the tarball
			untar(file, message.data.outputDir);
		} else if (message.type === 'shutdown') {
			// this is for exiting web worker properly
			downloading = false;
			process.exit(0);
		}
	});
}