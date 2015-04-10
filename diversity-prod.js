/* global process */
var Q          = require('q');
var fs         = require('q-io/fs');
var http       = require('q-io/http');
var LRU        = require('lru-cache');
var Url        = require('url');
var path       = require('path');
var express    = require('express');
var semver     = require('semver');
var app        = express();

var util       = require('./lib/util.js');
var api        = require('./lib/api.js');
var diversity  = require('./lib/diversity.js');
var render     = require('./lib/render.js');
var deps       = require('./lib/deps.js');
var cookieParser = require('cookie-parser');

var compress = require('compression');

if (process.argv[2] === '--help') {
  console.log('Usage:\n     node diversity-prod.js [<config-file>]');
  process.exit();
}

// Read config file if present.
var config = {};
var configFile = process.argv[2] || path.resolve(__dirname,'config.json');

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

app.use(compress());
app.use(cookieParser());

var RE_JUST_STAGE = /^http:\/\/([a-zA-Z]+)stage.textalk.se/;
var RE_DOMAIN_THEN_STAGE = /^http:\/\/.*(\.[a-zA-Z]+stage.textalk.se)/;

var pageUrlInfo = function(url, dontCatch) {
  //Always use http when querying the Url API
  url = url.replace('https://', 'http://');

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
    console.log('Rewrote stage url to', url);
  }

  var promise = api.call('Url.get', [url, true], {apiUrl: config.apiUrl}).then(function(info) {
    if (info.type === 'Moved') {
      if (url === info.url) {
        console.log('Stopping page url loop');
        return Q.reject();
      }
      return pageUrlInfo(info.url);
    }
    info.shopUrl = url;
    return info;
  });

  if (!dontCatch) {
    return promise.catch(function() {
      // If we err out we do another check, but this time with just the domain part.
      var parsed = Url.parse(url);
      console.log('Url.get failed ', url, 'so we are trying ', 'http://' + parsed.hostname + '/');
      return pageUrlInfo('http://' + parsed.hostname + '/', true);
    });
  }
  return promise;
};

app.get('/favicon.ico', function(req, res) {
  res.status(404).send('');
});

app.get('/backend/ha/check.txt', function(req, res) {
  res.send('ok');
});

app.get('/backend/stats/cache.txt', function(req, res) {
  var keys = cache.keys();
  res.send('Nr of keys: ' + keys.length + '\n' + JSON.stringify(keys, undefined, 2));
});

/**
 * Support old style tws-theme css
 */
app.get('/css/*', function(req, res) {
  var key = 'CSS:' + req.url;
  if (cache.has(key)) {
    res.setHeader('Content-Type', 'text/css');
    res.send(cache.get(key));
    return;
  }

  var url = config.diversityUrl + 'components/old-aficionado/*/css/' + req.url.substring(19);

  var request = {
    url: url,
    charset: 'UTF-8',
    method: 'GET',
  };
  return http.request(request).then(function(response) {
    if (response.status !== 200) {
      res.status(404).send('Not found.');
    }

    return response.body.read().then(function(r) {
      res.setHeader('Content-Type', 'text/css');
      res.send(r);
      cache.set(key, r);
    });
  });
});

// Handle queries on localhost
app.use(function(req, res, next) {

  if (req.query.shopUrl) {
    req.urlOverride = Url.parse(req.query.shopUrl, true);
    req.shopUrl = req.urlOverride.protocol +'//'+ req.urlOverride.hostname + req.urlOverride.path;
  } else {
    req.shopUrl = req.protocol +'://'+ req.hostname + req.url;
  }

  next();
});


// Handle redirects on previewkey request parameters
app.use(function(req, res, next) {

  // Check if we have previewkey req parameter
  if (req.query.previewkey && req.query.theme_id){
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

// TODO: refactor into middleware
app.get('*', function(req, res) {
  req.requestStartTime = Date.now();
  req.diversity = {};

  // First we checkout what webshop where on.
  pageUrlInfo(req.shopUrl).then(function(info) {  // <-- in a middleware?
    req.shopUrl = info.shopUrl || req.shopUrl;

    //TODO: check if something whent wrong.
    req.language = info.language;
    req.webshop  = info.webshop;

    var themeSelect = function() {
      var headers = {'user-agent': req.headers['user-agent']};
      if (headers['user-agent'].indexOf('Prerender')) {
	       headers['user-agent'] = "Mozilla/5.0 (iPhone; U; CPU iPhone OS 5_1_1 like Mac OS X; en) AppleWebKit/534.46.0 (KHTML, like Gecko) CriOS/19.0.1084.60 Mobile/9B206 Safari/7534.48.3";
      }
      return api.call('Theme.select', true, {
        apiUrl: config.apiUrl,
        webshop: info.webshop,
        language: info.language,
        headers: headers
      });
    };

    if (req.cookies['theme_id']) {
      // Theme id can have a preview auth token
      var split = req.cookies['theme_id'].split(';');
      var themeId = parseInt(split[0], 10);
      req.auth = split[1]; // can be undefined, thats fine.

      // Don't use cache when previewing
      if (req.auth) {
        req.dontCache = true;
      }

      // Check cache
      if (!isNaN(themeId)) {
        var key = info.webshop + '/' + themeId + '/' + info.language;
        if (!req.dontCache && cache.has(key)) {
          res.send(cache.get(key));
          console.log('Theme Cookie: Returning cached content for ', key, Date.now() - req.requestStartTime);
          return 'cached';
        }
      }

      return api.call(
        'Theme.get',
        [themeId],
        {webshop: info.webshop, language: info.language, auth: req.auth, apiUrl: config.apiUrl}
      ).catch(themeSelect); //On error do a theme select
    } else {
      return themeSelect();
    }
  }).then(function(theme) {
    req.theme = theme;
    // TODO: rafactor into middleware and get rid of this hack!

    if (theme === 'cached') {
      return;
    }

    req.key = req.webshop + '/' + theme.uid + '/' + req.language;

    // Check cache.
    if (theme.uid) {
      if (!req.dontCache && cache.has(req.key)) {
        res.send(cache.get(req.key));
        console.log('Returning cached content for ', req.key, Date.now() - req.requestStartTime);
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
                //console.log('Could not load template for ', json.name);
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
                //console.log('Could not load translation for ', json.name);
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
          var c = render.createContext(req.webshop, webshopUrl, config.apiUrl, req.swsUrl, config.diversityUrl, def);
          c.settings = obj.settings || {};
          c.settingsJSON = JSON.stringify(c.settings).replace(/<\/script>/g, '<\\/script>');
          obj.componentHTML = render.renderMustache(templates[obj.component], c, req.language);
        }
      });

      // Ok, time to render the theme Mustache
      var context = render.createContext(
        req.webshop,
        webshopUrl,
        config.apiUrl,
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

        if (typeof comp.script === 'string') {
          context.scripts.unshift(prefix(comp.name, comp.version, comp.script));
        } else if (typeof comp.script !== 'undefined') {
          context.scripts = comp.script.map(function(u) {
            return prefix(comp.name, comp.version, u);
          }).concat(context.scripts);
        }

        if (comp.angular) {
          context.modules[comp.angular] = true;
        }
      });

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

      cache.set(req.key, html);
      console.log('Returning renderered content for ',req.url, req.key, Date.now() - req.requestStartTime);
    });

  }).catch(function(err) {
    console.log("Returning 500: ", req.url, err);
    res.status(500).send('<!doctype html><html lang="en"><head> <meta charset="utf-8"> <meta name="viewport" content="width=device-width, initial-scale=1"> <title>Internal Server Error</title> <link href="http://fonts.googleapis.com/css?family=Droid+Sans" rel="stylesheet" type="text/css"> <style>html, body{background: #333; color: #fefefe; font-size: 22px; font-family: "Droid Sans", Verdana, Geneva, sans-serif;}body{padding: 25px; text-align: center;}</style></head><body> <h1>Internal Server Error (500)</h1> <h3>We are sorry, but something has gone really wrong.</h3> <p> Rest assured that we have logged the error and are looking into it as soon as possible.<br/> Try reloading the page in a little while. </p></body></html>');
  });
});




console.log('Starting server')
var server = app.listen(config.port, function() {
  console.log('Listening on port %d', server.address().port);
});
