/* global process, __dirname */
var Q          = require('q');
var LRU        = require('lru-cache');
var Url        = require('url');
var path       = require('path');
var express    = require('express');
var app        = express();

var util       = require('./lib/util.js');
var api        = require('./lib/api.js');
var diversity  = require('./lib/diversity.js');
var render     = require('./lib/render.js');
var cookieParser = require('cookie-parser');
var raven      = require('raven');

var compress = require('compression');

if (process.argv[2] === '--help') {
  console.log('Usage:\n     node diversity-prod.js [<config-file>]');
  process.exit();
}

// Read config file if present.
var config = {};
var configFile = process.argv[2] || path.resolve(__dirname, 'config.json');

try {
  config = JSON.parse(require('fs').readFileSync(configFile));
  console.log('Read config from', configFile, config);
} catch (e) {
  console.log('Could not load config file ', process.argv[2], e);
}

config.diversityUrl = config.diversityUrl || 'https://api.diversity.io/';
config.apiUrl       = config.apiUrl       || 'shop.textalk.se/backend/jsonrpc/v1/';
config.swsUrlOld    = config.swsUrlOld    || '/sws/';
config.cacheTTL     = config.cacheTTL     || 1000 * 60 * 5;
config.port         = config.port         || process.env.PORT || 3030;

// Set up simple lru page caching
var cache = LRU({max: 2000, maxAge: config.cacheTTL});


// Set up logging
var ravenClient = {
  captureMessage: function() {}
};

if (config.sentryDSN) {
  ravenClient = new raven.Client(config.sentryDSN);

  ravenClient.patchGlobal(function(e) {
    console.log('Crashed and burned', e);
    process.exit(1);
  });
}

app.use(compress());

var RE_JUST_STAGE = /^http:\/\/([a-zA-Z]+)stage.textalk.se/;
var RE_DOMAIN_THEN_STAGE = /^http:\/\/.*(\.[a-zA-Z]+stage.textalk.se)/;


/*************************************
 * Static Routes                     *
 *************************************/
var a404 = function(req, res) {
  res.status(404).send('');
};

var staticRoutes = {
  '/apple-touch-icon.png': a404,
  '/apple-touch-icon-precomposed.png': a404,
  '/favicon.ico': a404,
  '/backend/ha/check.txt': function(req, res) {
    res.send('ok');
  },
  '/backend/stats/cache.txt': function(req, res) {
    var keys = cache.keys();
    res.send('Nr of keys: ' + keys.length + '\n' + JSON.stringify(keys, undefined, 2));
  }
};

// Recursive Url.get, with stage rewrite.
var pageUrlInfo = function(url, req) {
  if (!req.pageUrlInfoLog) {
    req.pageUrlInfoLog = [];
  }

  var logLoop = function(msg) {
    var kwargs = raven.parsers.parseRequest(req);
    kwargs.extra = {
      incomingUrl: req.incomingUrl,
      shopUrl: req.shopUrl,
      headers: req.headers,
      pageUrlInfoLog: req.pageUrlInfoLo
    };
    kwargs.level = 'warning';
    ravenClient.captureMessage(msg + ' ' + req.incomingUrl, kwargs);
  };


  var deferred = Q.defer();
  var recursiveUrlGet = function(currentUrl, opts, depth) {
    if (depth <= 0) {
      logLoop('Stopping too deep Url moved structure or loop');
      return Q.reject('Stopping Url.get loop, to many queries', currentUrl);
    }

    return api.call('Url.get', [currentUrl, true], opts).then(function(info) {
      req.pageUrlInfoLog.push(info);
      if (info.type === 'Moved') {
        if (url === info.url || info.url === req.incomingUrl) {
          console.log(new Date(), req.incomingUrl, 'Stopping page url loop');
          logLoop('Stopping Url "moved" loop');
          return Q.reject('loop');
        }

        return recursiveUrlGet(info.url, opts, depth - 1);
      }
      req.shopUrl  = currentUrl;
      req.language = info.language;
      req.webshop  = info.webshop;
      return info;
    });
  };

  recursiveUrlGet(url, {apiUrl: req.apiUrl, auth: req.auth}, 5).then(function(info) {
    deferred.resolve(info);
  }, function(err) {
    if (err && err.code === 9003) {
      // Ok we couldn't find the url, let's try the domain part.
      var parsed = Url.parse(url);
      console.log(new Date(), req.incomingUrl, 'Url.get failed ', url, 'so we are trying ', 'http://' + parsed.hostname + '/');

      recursiveUrlGet('http://' + parsed.hostname + '/', {apiUrl: req.apiUrl, auth: req.auth}, 5).then(function(info) {
        deferred.resolve(info);
      }).catch(function(err) {
        deferred.reject(err);
      });

    } else {
      deferred.reject(err);
    }
  });

  return deferred.promise;
};

var error = function(err, req, res) {
  console.log(new Date(), req.incomingUrl, 'Returning 500: ', err);
  res.status(500).send('<!doctype html><html lang="en"><head> <meta charset="utf-8"> <meta name="viewport" content="width=device-width, initial-scale=1"> <title>Internal Server Error</title> <link href="http://fonts.googleapis.com/css?family=Droid+Sans" rel="stylesheet" type="text/css"> <style>html, body{background: #333; color: #fefefe; font-size: 22px; font-family: "Droid Sans", Verdana, Geneva, sans-serif;}body{padding: 25px; text-align: center;}</style></head><body> <h1>Internal Server Error (500)</h1> <h3>We are sorry, but something has gone really wrong.</h3> <p> Rest assured that we have logged the error and are looking into it as soon as possible.<br/> Try reloading the page in a little while. </p></body></html>');

  var kwargs = raven.parsers.parseRequest(req);
  kwargs.extra = {
    incomingUrl: req.incomingUrl,
    shopUrl: req.shopUrl,
    webshop: req.webshop,
    language: req.language,
    auth: req.auth,
    error: err
  };
  kwargs.tags = {response: '500'};
  kwargs.level = 'error';

  ravenClient.captureMessage('500', kwargs);
};

/****************************************
 * Middleware                           *
 ****************************************/

// Static routes
app.use(function(req, res, next) {
  if (staticRoutes[req.url]) {
    staticRoutes[req.url](req, res, next);
  } else {
    next();
  }
});

// Parse cookies
app.use(cookieParser());

app.use(function(req, res, next) {
  // Used for logging
  req.incomingUrl = 'http://' + req.hostname + req.url;
  req.requestStartTime = Date.now();

  next();
});

// Stage check
app.use(function(req, res, next) {
  // The default
  req.apiUrl = config.apiUrl;

  if (req.hostname.indexOf('stage.textalk.se') !== -1) {
    // Used for logging
    var m = RE_DOMAIN_THEN_STAGE.exec('http://' + req.hostname);
    if (m && m[1]) {

      // Force http on stage
      req.apiUrl = 'http://' + m[1].substring(1) + '/backend/jsonrpc/v1/';
    }
    req.isStage = true;
  }
  next();
});

// Handle theme_id busting.
// The problem is that HA Proxy redirects to Diversity if a theme_id cookie is present
// effectively stopping us from previewing classic templates.
// If we get a  `theme=classic request parameter we kill the cookie and redirect to ourselves
// so that the HA proxy can do it's thing.
app.use(function(req, res, next) {
  if (req.query.theme === 'classic') {
    console.log(new Date(), req.incomingUrl, 'Got theme=classic, redirecting');

    var url = req.path;
    delete req.query.theme;
    res.clearCookie('theme_id');

    var query = Object.keys(req.query).map(function(name) {
      return name + '=' + req.query[name];
    }).join('&');

    if (query.length > 0) {
      url += '?' + query;
    }
    res.redirect(url);
    return;
  }
  next();
});

// Handle redirects on previewkey request parameters
app.use(function(req, res, next) {
  // Check if we have previewkey req parameter
  //if (req.originalUrl !== '/backend/ha/check.txt') {
  //  console.log(new Date(), req.incomingUrl, 'Checking for previewkey', req.query.previewkey, req.query.theme_id, req.get('Cookie'));
  //}
  if (req.query.previewkey && req.query.theme_id) {
    console.log(new Date(), req.incomingUrl, 'Got previewkey, redirecting');
    res.cookie(
      'theme_id',
      req.query.theme_id + ';' + req.query.previewkey
    );

    var url = req.path;
    delete req.query.previewkey;
    delete req.query.theme_id;

    var query = Object.keys(req.query).map(function(name) {
      return name + '=' + req.query[name];
    }).join('&');

    if (query.length > 0) {
      url += '?' + query;
    }
    res.redirect(url);
    return;
  }
  next();
});

// Parse possible theme_id cookie
app.use(function(req, res, next) {
  if (req.cookies['theme_id']) {
    // Theme id can have a preview auth token
    var split = req.cookies['theme_id'].split(';');
    req.themeUid = parseInt(split[0], 10);
    req.themeUid = isNaN(req.themeUid) ? undefined : req.themeUid;
    req.auth = split[1]; // can be undefined, thats fine.
    console.log(new Date(), req.incomingUrl, 'Theme id cookie', req.themeUid, req.auth);
  }
  next();
});


// What shop is this?
app.use(function(req, res, next) {
  pageUrlInfo(req.incomingUrl, req).then(function() {
    next();
  }, function(err) {

    // No page? 404
    res.status(404).send('<!doctype html><html lang="en"><head> <meta charset="utf-8"> <meta name="viewport" content="width=device-width, initial-scale=1"> <title>Page Not Found</title> <link href="http://fonts.googleapis.com/css?family=Droid+Sans" rel="stylesheet" type="text/css"> <style>html, body{background: #333; color: #fefefe; font-size: 22px; font-family: "Droid Sans", Verdana, Geneva, sans-serif;}body{padding: 25px; text-align: center;}</style></head><body> <h1>Page Not Found (404)</h1> <h3>We are sorry, but we could not find the page you are looking for.</h3></body></html>');

    var kwargs = raven.parsers.parseRequest(req);
    kwargs.extra = {
      incomingUrl: req.incomingUrl,
      shopUrl: req.shopUrl,
      headers: req.headers,
      pageUrlInfoLog: req.pageUrlInfoLog,
      error: err
    };
    kwargs.tags = {response: '404'};
    kwargs.level = 'warning';
    ravenClient.captureMessage('404 ' + req.incomingUrl, kwargs);
  });
});

// Theme get/Select
app.use(function(req, res, next) {
  var themeSelect = function() {
    var headers = {'user-agent': req.headers['user-agent']};
    if (headers['user-agent'].indexOf('Prerender') !== -1) {
       headers['user-agent'] = 'Mozilla/5.0 (iPhone; U; CPU iPhone OS 5_1_1 like Mac OS X; en) AppleWebKit/534.46.0 (KHTML, like Gecko) CriOS/19.0.1084.60 Mobile/9B206 Safari/7534.48.3';
    }
    api.call('Theme.select', true, {
      apiUrl: req.apiUrl,
      webshop: req.webshop,
      language: req.language,
      headers: headers,
      auth: req.auth
    }).then(function(theme) {
      req.theme = theme;
      next();
    }, function(err) {
      error(err, req, res);
    });
  };

  // Did we get a theme id by cookie
  if (req.themeUid) {
    // Check cache
    var key = req.webshop + '/' + req.themeUid + '/' + req.language;
    if (!req.auth && cache.has(key)) { // Don't cache when we have auth key
      res.send(cache.get(key));
      console.log(new Date(), req.incomingUrl, 'Theme Cookie: Returning cached content for ', key, Date.now() - req.requestStartTime);
      return;
    }

    api.call(
      'Theme.get',
      [req.themeUid],
      {webshop: req.webshop, language: req.language, auth: req.auth, apiUrl: req.apiUrl}
    ).then(function(theme) {
      req.theme = theme;
      next();
    }).catch(themeSelect); //On error do a theme select and see if that works instead
  } else {
    themeSelect();
  }
});

// Error handling middleware
// Don't remove 'next' or express doesn't know what it is.
app.use(function(err, req, res, next) { // jshint ignore:line
  error(err, req, res);
});


/*****************************
 * Main route                *
 *****************************/
// TODO: refactor into middleware

var CLEAN_RE = /[\^~]*/;
var VERSION_RE = /^[0-9.]+$/;

app.get('*', function(req, res) {
  var theme = req.theme;
  req.key = req.webshop + '/' + theme.uid + '/' + req.language;

  // Check cache (again).
  if (theme.uid) {
    if (!req.auth && cache.has(req.key)) { // Don't cache when we have auth key
      res.send(cache.get(req.key));
      console.log(new Date(), req.incomingUrl, 'Returning cached content for ', req.key, Date.now() - req.requestStartTime);
      return;
    }
  }

  // Sanity check
  if (!theme.params || !theme.params.component) {
    return Q.reject('No component in theme');
  }

  // Old theme or new theme?
  if (theme.params.component === 'tws-theme') {
    req.swsUrl = config.swsUrlOld; // Old style
  } else {
    req.swsUrl = config.diversityUrl;
  }

  // Diversity API don't take semver, but 1.0 will parsed as the latest patch, wich we want.
  // but just in the case of the theme component
  var cleanVersion = (theme.params.version || '').replace(CLEAN_RE, '');
  //console.log('Clean version is ' + cleanVersion, 'was', theme.params.version);
  var componentsToLoad = [{
    component: theme.params.component,
    version: VERSION_RE.test(cleanVersion) ? cleanVersion : '*'
  }];

  // Until api handles ^ versions we go with *
  util.findComponentsInSettings(theme.params.settings || {}, function(comp) {
    comp.version = '*'; //comp.version || '*';
    componentsToLoad.push(comp);
  });

  var components = {};
  var translations = {};
  var templates = {};
  var language  = req.language;

  // Load a component all of its dependencies.
  // Also load any mustach template is has and any translation.
  var loadComponent = function(obj) {
    if (!obj) {
      return;
    }

    // It might already be loaded.
    if (!components[obj.component]) {
      components[obj.component] = true; //stop anyone else loading it.
      return diversity.getDiveristyJson(
        config.diversityUrl,
        obj.component,
        obj.version
      ).then(function(json) {
        components[obj.component] = json;
        var promises = [];

        if (json.template) {
          promises.push(
            diversity.getFile(
              config.diversityUrl,
              json.name,
              json.version,
              json.template
            ).then(function(data) {
              templates[json.name] = data;
            }, function() {
              //console.log(new Date(), req.incomingUrl, 'Could not load template for ', json.name);
            })
          );
        }

        if (json.i18n && json.i18n[language] && json.i18n[language].view) {
          promises.push(
            diversity.getFile(
              config.diversityUrl,
              json.name,
              json.version,
              json.i18n[language].view
            ).then(function(data) {
              translations[json.name] = data;
            }, function() {
              // Errors here sould not stop all loading.
              //console.log(new Date(), req.incomingUrl, 'Could not load translation for ', json.name);
            })
          );
        }

        if (json.dependencies) {
          Object.keys(json.dependencies).forEach(function(name) {
            // FIXME: handle versions
            promises.push(
              loadComponent({component: name, version:'*'})
            );
          });
        }

        if (promises.length > 0) {
          return Q.all(promises);
        }

      });
    }
  };

  return Q.all(componentsToLoad.map(loadComponent)).then(function() {
    var webshopUrl = req.shopUrl;

    // Is this a prerender run?
    var prerender = false;
    if (req.headers['user-agent'] && req.headers['user-agent'].indexOf('Prerender') !== -1) {
      prerender = true;
    }

    // Time to render templates
    util.findComponentsInSettings(req.theme.params.settings || {}, function(obj) {
      // findComponentsInSettings goes depth first and applies children before parents
      var def = components[obj.component];
      if (def.template) {
        var c = render.createContext(req.webshop, webshopUrl, req.apiUrl, req.swsUrl, config.diversityUrl, def, undefined, prerender);
        c.settings = obj.settings || {};
        c.settingsJSON = JSON.stringify(c.settings).replace(/<\/script>/g, '<\\/script>');
        obj.componentHTML = render.renderMustache(templates[obj.component], c, req.language);
      }
    });

    // Ok, time to render the theme Mustache
    var context = render.createContext(
      req.webshop,
      webshopUrl,
      req.apiUrl,
      req.swsUrl,
      config.diversityUrl,
      components[req.theme.params.component],
      req.auth
    );
    var prefix = render.prefixFactory(config.diversityUrl);

    util.traverseDeps(Object.keys(components), components, function(comp) {
      if (typeof comp.style === 'string') {
        context.styles.push(prefix(comp.name, comp.version, comp.style));
      } else if (typeof comp.style !== 'undefined') {
        context.styles = comp.style.map(function(u) {
          return prefix(comp.name, comp.version, u);
        }).concat(context.styles);
      }

      // Scripts can be servered minfied from the diversity api server
      // In that case we need a large URL, otherwise we need to gather scripts
      if (!config.minifiedJs) {
        // The non minified way of one script at a time.
        if (typeof comp.script === 'string') {
          context.scripts.unshift(prefix(comp.name, comp.version, comp.script));
        } else if (typeof comp.script !== 'undefined') {
          context.scripts = comp.script.map(function(u) {
            return prefix(comp.name, comp.version, u);
          }).concat(context.scripts);
        }
      } else {
        //The new way, one large url.
        if (comp.script) {
          context.scripts.unshift(comp.name + '=' + comp.version);
        }
      }

      if (comp.angular) {
        context.modules[comp.angular] = true;
      }
    });

    // Create one large minfied url if it's configed
    if (config.minifiedJs) {
      context.scripts = [config.diversityUrl + 'minify-js?' + context.scripts.join('&')];
    }

    // Filter out scss files.
    var re = /.*\.scss$/;
    context.styles = context.styles.filter(function(s) { return !re.test(s); });

    context.settings = req.theme.params.settings || {};
    context.l10n = Object.keys(translations).map(function(key) {
      return {
        component: key,
        messages: translations[key]
      };
    });

    // Since settingsJSON is going up to the server we need to clean out redundant code.
    util.findComponentsInSettings(context.settings, function(obj) {
      delete obj.settings;
    }, true);

    context.settingsJSON = JSON.stringify(context.settings).replace(/<\/script>/g, '<\\/script>');

    context.angularBootstrap = 'angular.module("tws",["' +
                                Object.keys(context.modules).join('","') +
                               '"])\n' + 'angular.bootstrap(document,["tws"])';

    // Lets render main mustache template, and send it.
    var html = render.renderMustache(templates[req.theme.params.component], context, req.language);
    res.send(html);

    //cache.set(req.key, html);
    console.log(new Date(), req.incomingUrl, 'Returning renderered content for ',req.url, req.key, Date.now() - req.requestStartTime);
  }).catch(function(err) {
    error(err, req, res);
  });
});

console.log('Starting server');
var server = app.listen(config.port, function() {
  console.log('Listening on port %d', server.address().port);
});
