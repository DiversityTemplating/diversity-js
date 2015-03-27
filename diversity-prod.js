/* global process */
var Q          = require('q');
var fs         = require('q-io/fs');
var http       = require('q-io/http');
var LRU        = require('lru-cache');

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

var DIVERSITY_URL = 'https://api.diversity.io/';
var API_URL       = 'shop.textalk.se/backend/jsonrpc/v1/';

if (process.argv[2] === '--help') {
  console.log('Usage:\n     node diversity-prod.js');
  process.exit();
}


// Set up simple lru page caching
var cache = LRU({max: 2000, maxAge: 1000*60*5});

app.use(cookieParser());

var pageUrlInfo = function(url) {
  return api.call('Url.get', [url, true], {apiUrl: API_URL}).then(function(info) {
    if (info.type === 'Moved') {
      if (url === info.url) {
        console.log('Stopping page url loop');
        return Q.reject();
      }
      return pageUrlInfo(info.url);
    }
    return info;
  });
};

app.get('/favicon.ico', function(req, res) {
  res.status(404).send('');
});

app.get('/backend/ha/check.txt', function(req, res) {
  res.send('ok');
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

  console.log(req.url.substring(19))
  var url = DIVERSITY_URL + 'components/old-aficionado/*/css/' + req.url.substring(19);
  /*var query = Object.keys(req.query).map(function(name) {
    return name + '=' + req.query[value];
  }).join('&');
*/
  console.log(url);
  var request = {
    url: url,
    charset: 'UTF-8',
    method: 'GET',
  };
  return http.request(request).then(function(response) {
    if (response.status !== 200) {
      console.log('Not 200', response);
      res.status(404).send('Not found.');
    }

    return response.body.read().then(function(r) {
      res.setHeader('Content-Type', 'text/css');
      res.send(r);
      cache.set(key, r);
    });
  });
});



// TODO: refactor into middleware
app.get('*', function(req, res) {

  // Check if we have previewkey req parameter
  if (req.query.previewkey && req.query.theme_id){
    res.cookie(
      'theme_id',
      req.query.theme_id + ';' + req.query.previewkey
    );

    var url = req.protocol + '://' + req.hostname + req.path;



    delete req.query.previewkey;
    delete req.query.theme_id;

    var query = Object.keys(req.query).map(function(name) {

      return name + '=' + req.query[name];
    }).join('&');

    if (query.length > 0) {
      url += '?' + query;
    }
    console.log('Redirecting to:', url);
    res.redirect(url);
    return;
  }

  req.diversity = {};
  console.log(req.url, req.hostname);
  // First we checkout what webshop where on.
  pageUrlInfo(req.protocol +'://'+ req.hostname + req.url).then(function(info) {  // <-- in a middleware?

    //TODO: check if something whent wrong.
    req.language = info.language;
    req.webshop  = info.webshop;

    if (req.cookies['theme_id']) {
      // Theme id can have a preview auth token
      var split = req.cookies['theme_id'].split(';');
      var themeId = parseInt(split[0], 10);
      var auth = split[1]; // can be undefined, thats fine.

      // Check cache
      if (!isNaN(themeId)) {
        var key = info.webshop + '/' + themeId;
        if (cache.has(key)) {
          console.log('returning cached content for ', key);
          res.send(cache.get(key));
          return 'cached';
        }
      }

      return api.call(
        'Theme.get',
        [themeId],
        {webshop: info.webshop, language: info.language, auth: auth, apiUrl: API_URL}
      );
    } else {

      // Do Theme.select
      console.log('doing theme select')
      return api.call('Theme.select', true, {
        apiUrl: API_URL,
        webshop: info.webshop,
        language: info.language,
        headers: {
          'user-agent': req.headers['user-agent']
        }
      });
    }
  }).then(function(theme) {
    req.theme = theme;
    // TODO: rafactor into middleware and get rid of this hack!

    if (theme === 'cached') {
      return;
    }

    // Check cache
    if (theme.uid) {
      var key = req.webshop + '/' + theme.uid;
      if (cache.has(key)) {
        console.log('returning cached content for ', key);
        res.send(cache.get(key));
        return;
      }
    }

    // Sanity check
    if (!theme.params || !theme.params.component) {
      return Q.reject('No component in theme');
    }

    // Old theme or new theme?
    if (theme.params.component === 'tws-theme') {
      req.swsUrl = 'css/'; // Old style
    } else {
      req.swsUrl = DIVERSITY_URL;
    }

    var componentsToLoad = [{
      component: theme.params.component,
      version: theme.params.version || '*'
    }];

    util.findComponentsInSettings(theme.params.settings || {}, function(comp) {
      comp.version = comp.version || '*';
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
        return diversity.getDiveristyJson(obj.component, obj.version).then(function(json) {
          components[obj.component] = json;
          var promises = [];

          if (json.template) {
            promises.push(
              diversity.getFile(json.name, json.version, json.template).then(function(data) {
                templates[json.name] = data;
              }, function() {
                console.log('Could not load template for ', json.name);
              })
            );
          }

          if (json.i18n && json.i18n[language] && json.i18n[language].view) {
            promises.push(
              diversity.getFile(
                json.name,
                json.version,
                json.i18n[language].view
              ).then(function(data) {
                translations[json.name] = data;
              }, function() {
                // Errors here sould not stop all loading.
                console.log('Could not load translation for ', json.name);
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
      console.log('Nr of components ', Object.keys(components).length);

      // TODO: Not sure if this is correct
      var webshopUrl = req.protocol + '://' + req.hostname + '/';

      // Time to render templates
      util.findComponentsInSettings(req.theme.params.settings || {}, function(obj) {
        // findComponentsInSettings goes depth first and applies children before parents
        var def = components[obj.component];
        if (def.template) {
          var c = render.createContext(req.webshop, webshopUrl, API_URL, req.swsUrl);
          c.settings = obj.settings || {};
          c.settingsJSON = JSON.stringify(c.settings).replace(/<\/script>/g, '<\\/script>');
          obj.componentHTML = render.renderMustache(templates[obj.component], c, req.language);
        }
      });

      // Ok, time to render the theme Mustache
      var context = render.createContext(req.webshop, webshopUrl, API_URL, req.swsUrl);
      var prefix = render.prefixFactory(DIVERSITY_URL);

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
      context.baseUrl = '/deps/' + req.themeName + '/';

      // Lets render main mustache template, and send it.
      var html = render.renderMustache(templates[req.theme.params.component], context, req.language);
      res.send(html);

      cache.set(req.webshop + '/' + req.theme.uid, html);
    });

  }).catch(function(err) {
    console.log(err);
    res.status(500).send('Internal server error.');
  });
});




console.log('Starting server')
var server = app.listen(process.env.PORT || 3000, function() {
  console.log('Listening on port %d', server.address().port);
});
