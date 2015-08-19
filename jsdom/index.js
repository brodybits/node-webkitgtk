var debug = require('debug')('webkitgtk');
var jsdom = require('jsdom').jsdom;
var httpCodes = require('http').STATUS_CODES;

var request = function() { // lazy loading request
	var request;
	try {
		request = require('request');
	} catch(e) {
		console.error("Please `npm install request` to be able to load remote documents");
		process.exit(1);
	}
	return request;
};

function modURL(document) {
	var Mod;
	try {
		Mod = require('urlutils');
	} catch(e) {
		console.error("Please `npm install urlutils` when using jsdom 3");
		process.exit(1);
	}
	function URL(url, base) {
		// work around current urlutils limitation
		if (!base) base = document.location.href;
		return Mod(url, base);
	}
	return URL;
}



module.exports = function(WebKit) {

WebKit.prototype.binding = function(opts, cfg, cb) {
	this.priv.jsdom = {
		MutationEvents : '2.0',
		QuerySelector : true
	};
	this.priv.cfg = cfg;
	cb();
};

WebKit.prototype.rawload = function(uri, opts, cb) {
	var jsdomOpts = {
		resourceLoader: resourceLoader.bind(this),
		features: {}
	};
	var priv = this.priv;

	for (var jk in priv.jsdom) jsdomOpts.features[jk] = priv.jsdom[jk];
	if (opts.preload) {
		jsdomOpts.features.FetchExternalResources = [];
		jsdomOpts.features.ProcessExternalResources = [];
	} else {
		jsdomOpts.features.FetchExternalResources = ['script'];
		jsdomOpts.features.ProcessExternalResources = ['script'];
	}

	jsdomOpts.url = uri;
	var cookies = opts.cookies;
	if (cookies) {
		if (!Array.isArray(cookies)) cookies = [cookies];
		if (cookies.length) cookies = cookies.join(';');
		else cookies = null;
	}

	jsdomOpts.created = function(err, window) {
		window.raise = function(ev, msg, obj) {
			if (obj && obj.error) {
				throw obj.error;
			}
		};
		if (err) return cb(err);
		window.uri = uri;
		this.webview = window;

		if (cookies) {
			debug('load cookies');
			window.document.cookie = cookies;
			window.document._cookieDomain = window.document.location.hostname;
		}
		if (opts.console) window.console = console;
		if (!window.URL) window.URL = modURL(window.document);
		require('./classlist')(window);

		handleXhr.call(this, window);
		window.addEventListener(priv.eventName, function(e) {
			priv.cfg.eventsListener(null, e.char);
		}.bind(this), false);

		if (opts.script) window.run(opts.script);
		this.status = 200;
		cb(null, 200);
	}.bind(this);

	this.webview = {
		uri: uri
	};

	setImmediate(function() {
		if ((!uri || uri == "about:blank") && opts.content == null) {
			opts.content = '<html><head></head><body></body></html>';
		}
		if (opts.content != null) {
			jsdom(opts.content, jsdomOpts);
		} else {
			// trick to have a main uri before loading main doc
			this.webview.loading = true;
			var loader = resourceLoader.call(this, {
				url: { href: uri },
				cookie: cookies
			}, function(err, body) {
				this.webview.loading = false;
				var status = 200;
				if (err) {
					status = err.code || 0;
					if (typeof status == "string") status = 0;
				}
				if (err || status != 200) return cb(err, status);
				jsdom(body, jsdomOpts);
			}.bind(this));
			this.webview.stop = function stop(cb) {
				if (this.webview.loading) {
					this.webview.loading = false;
					if (loader.req) loader.req.abort();
					setImmediate(cb);
					return true;
				} else {
					return false;
				}
				// return nothing and WebKit.stop will callback on our behalf
			}.bind(this);
		}
	}.bind(this));
};

};

function HTTPError(code) {
	Error.call(this, httpCodes[code]);
	this.code = code;
	return this;
};
HTTPError.prototype = Object.create(Error.prototype);
HTTPError.prototype.constructor = HTTPError;

function emitIgnore(reqObj) {
	var evt = this.webview.document.createEvent("KeyboardEvent");
	evt.initEvent('r' + this.priv.eventName, false, true);
	evt.keyIdentifier = reqObj.uri;
	this.webview.dispatchEvent(evt);
}

function resourceLoader(resource, cb) {
	// Checking if the ressource should be loaded
	var uri = resource.url && resource.url.href;
	debug("resource loader", uri);
	var priv = this.priv;
	var reqObj = {uri: uri, Accept: "*/*"};
	priv.cfg.requestListener(reqObj);
	if (reqObj.ignore) emitIgnore.call(this, reqObj);
	if (reqObj.cancel) {
		priv.cfg.responseListener(uticket, {uri: uri, length: 0, headers: {}, status: 0});
		var err = new Error("Ressource canceled");
		err.statusCode = 0;
		return cb(err);
	}
	var uticket = priv.uticket;
	// actual get
	delete reqObj.uri;
	delete reqObj.cancel;
	delete reqObj.ignore;
	var reqOpts = {
		url: uri,
		headers: reqObj,
		jar: request().jar()
	};
	if (resource.cookie) {
		reqOpts.jar.setCookie(request().cookie(resource.cookie), uri);
	}
	return request()(reqOpts, function(err, res, body) {
		var status = res && res.statusCode || 0;
		if (!err && status != 200) err = new HTTPError(status);
		var headers = res && res.headers || {};
		priv.cfg.responseListener(uticket, {
			uri: uri,
			headers: headers,
			length: body ? body.length : 0,
			mime: headers['content-type'],
			status: status,
			data: function(cb) {
				cb(null, body);
			}
		});
		cb(err, body);
	}.bind(this))
	.on('data', function(chunk) {
		priv.cfg.receiveDataListener(uticket, uri, chunk ? chunk.length : 0);
	}.bind(this));
}

function handleXhr(window) {
	var webview = this;
	var priv = this.priv;
	var uticket = priv.uticket;
	var wxhr = window.XMLHttpRequest;
	window.XMLHttpRequest = function() {
		var xhr = wxhr();
		var xhrSend = xhr.send;
		var xhrOpen = xhr.open;
		var xhrSetRequestHeader = xhr.setRequestHeader;
		var privUrl;
		var reqObj = {
			Accept: "*/*"
		};
		function listenXhr(e) {
			if (this.readyState != this.DONE) return;
			// crash - probably a node-xmlhttprequest bug
			// this.removeEventListener("readystatechange", listenXhr, false);
			var headers = {};
			var contentType;
			this.getAllResponseHeaders().split('\r\n').map(function(line) {
				return line.split(':').shift();
			}).forEach(function(name) {
				var val = this.getResponseHeader(name);
				if (name.toLowerCase() == "content-type") contentType = val;
				if (val != null) headers[name] = val;
			}.bind(this));
			if (this.responseType == 'document' && contentType.indexOf('text/html') >= 0) {
				this.responseXML = jsdom(this.responseText, webview.priv.jsdom);
			}
			priv.cfg.responseListener(uticket, {
				uri: privUrl,
				status: this.status,
				headers: headers,
				mime: contentType
			});
		}

		xhr.open = function(method, url) {
			if (method.toLowerCase() == "get") privUrl = (new window.URL(url)).href;
			return xhrOpen.apply(this, Array.prototype.slice.call(arguments, 0));
		};
		xhr.setRequestHeader = function(name, val) {
			var ret = xhrSetRequestHeader.call(xhr, name, val);
			reqObj[name] = val;
			return ret;
		};
		xhr.send = function(data) {
			// while xhr is typically not reused, it can happen, so support it
			var ret, err;
			try {
				ret = xhrSend.call(this, data);
			} catch(e) {
				err = e;
			}
			reqObj.uri = privUrl;
			priv.cfg.requestListener(reqObj);
			if (reqObj.ignore) emitIgnore.call(webview, reqObj);
			if (reqObj.cancel) this.abort();
			if (this.readyState == 4 || err) {
				// free it now
				listenXhr.call(this, err);
			} // else the call was asynchronous and no error was thrown
			if (err) throw err; // rethrow
			return ret;
		};

		xhr.addEventListener("readystatechange", listenXhr, false);

		return xhr;
	};
}
