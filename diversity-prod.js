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
var staticRoutes = {
  '/favicon.ico': function(req, res) {
    res.status(404).send('');
  },
  '/backend/ha/check.txt': function(req, res) {
    res.send('ok');
  },
  '/backend/stats/cache.txt': function(req, res) {
    var keys = cache.keys();
    res.send('Nr of keys: ' + keys.length + '\n' + JSON.stringify(keys, undefined, 2));
  }
};

// Recursive Url.get, with stage rewrite.
var pageUrlInfo = function(url, req, dontCatch) {

  if (!req.pageUrlInfoLog) {
    req.pageUrlInfoLog = [];
  }

  // Handle stage url:s
  if (url.indexOf('stage.textalk.se') !== -1) {
    // Lets rewrite it!
    // someonestage.textalk.se -> jenkinsstage.textalk.se
    var stage = RE_JUST_STAGE.exec(url);
    if (stage) {
      url = url.replace(stage[1], 'jenkins');
    } else {
      // or
      // shop.heynicebeard.com.someonestage.textalk.se -> shop.heynicebeard.com
      stage = RE_DOMAIN_THEN_STAGE.exec(url);
      url = url.replace(stage[1], '');
    }
    req.pageUrlInfoLog.push(req.incomingUrl + ' rewritten to ' + url);
    console.log(new Date(), req.incomingUrl, 'Rewrote stage url to', url);
  }

  var promise = api.call('Url.get', [url, true], {apiUrl: req.apiUrl, auth: req.auth}).then(function(info) {
    req.pageUrlInfoLog.push(info);
    if (info.type === 'Moved') {
      if (url === info.url || info.url === req.incomingUrl) {
        console.log(new Date(), req.incomingUrl, 'Stopping page url loop');
        return Q.reject();
      }
      return pageUrlInfo(info.url, req);
    }
    req.shopUrl  = url;
    req.language = info.language;
    req.webshop  = info.webshop;
    return info;
  });

  if (!dontCatch) {
    return promise.catch(function() {
      // If we err out we do another check, but this time with just the domain part.
      var parsed = Url.parse(url);
      console.log(new Date(), req.incomingUrl, 'Url.get failed ', url, 'so we are trying ', 'http://' + parsed.hostname + '/');
      return pageUrlInfo('http://' + parsed.hostname + '/', req, true);
    });
  }
  return promise;
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

// Handle redirects on previewkey request parameters
app.use(function(req, res, next) {
  // Check if we have previewkey req parameter
  if (req.originalUrl !== '/backend/ha/check.txt') {
    console.log(new Date(), req.incomingUrl, 'Checking for previewkey', req.query.previewkey, req.query.theme_id, req.get('Cookie'));
  }
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
  }, function() {
    // No page? 404
    res.status(404).send('<!doctype html><html lang="en"><head> <meta charset="utf-8"> <meta name="viewport" content="width=device-width, initial-scale=1"> <title>Page Not Found</title> <link href="http://fonts.googleapis.com/css?family=Droid+Sans" rel="stylesheet" type="text/css"> <style>html, body{background: #333; color: #fefefe; font-size: 22px; font-family: "Droid Sans", Verdana, Geneva, sans-serif;}body{padding: 25px; text-align: center;}</style></head><body> <h1>Page Not Found (404)</h1> <h3>We are sorry, but we could not find the page you are looking for.</h3></body></html>');

    var kwargs = raven.parsers.parseRequest(req);
    kwargs.extra = {
      incomingUrl: req.incomingUrl,
      shopUrl: req.shopUrl,
      headers: req.headers,
      pageUrlInfoLog: req.pageUrlInfoLog
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
    if (headers['user-agent'].indexOf('Prerender')) {
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
app.use(function(err, req, res, next) {
  error(err, req, res);
});


/*****************************
 * Main route                *
 *****************************/
// TODO: refactor into middleware
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

  // Until api handles ^ versions we go with *
  var componentsToLoad = [{
    component: theme.params.component,
    version: '*' //theme.params.version || '*'
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

    // Time to render templates
    util.findComponentsInSettings(req.theme.params.settings || {}, function(obj) {
      // findComponentsInSettings goes depth first and applies children before parents
      var def = components[obj.component];
      if (def.template) {
        var c = render.createContext(req.webshop, webshopUrl, req.apiUrl, req.swsUrl, config.diversityUrl, def);
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

console.log('Starting server')
var server = app.listen(config.port, function() {
  console.log('Listening on port %d', server.address().port);
});
