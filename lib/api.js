/* global Buffer, exports */
var http  = require('q-io/http');
var reqId = 1;
var Q     = require('q');


var buildUrl = function(apiUrl, webshop, language, auth) {
  var delimeter = '?';

  if (apiUrl.indexOf('http') !== 0) {
    apiUrl = 'https://' + apiUrl;
  }

  if (webshop) {
    apiUrl += delimeter + 'webshop=' + webshop;
    delimeter = '&';
  }

  if (language) {
    apiUrl += delimeter + 'language=' + language;
    delimeter = '&';
  }

  if (auth) {
    apiUrl += delimeter + 'auth=' + auth;
  }
  return apiUrl;
};

var callApi = function(method, params, options) {
  options = options || {};
  if (!Array.isArray(params)) {
    params = [params];
  }
  var url  = options.url || buildUrl(options.apiUrl, options.webshop, options.language, options.auth);

  var body = JSON.stringify({
    jsonrpc: '2.0',
    id: reqId++,
    method: method,
    params: params
  });

  var headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body, 'utf8')
  };

  if (options.headers) {
    Object.keys(options.headers).forEach(function(key) {
      headers[key] = options.headers[key];
    });
  }

  var request = {
    url: url,
    charset: 'UTF-8',
    method: 'POST',
    headers: headers,
    body: [body]
  };

  //console.log('Doing req',url, method, params);
  var start = Date.now();
  var deferred = Q.defer();

  http.request(request).then(function(response) {
    if (response.status !== 200) {
      console.log('Not 200', response);
      return deferred.reject(response);
    }

    return response.body.read().then(function(r) {
      var res;
      try {
        res = JSON.parse(r);
      } catch (e) {
        return deferred.reject('Not valid JSON in response from API', method, params);
      }

      if (res.result) {
        //console.log('Took ', Date.now() - start);
        deferred.resolve(res.result);
        return;
      }
      console.log('JSON RPC Error', method, params, res.error);
      return deferred.reject(res.error);
    });
  }).catch(function(err) {
    console.log('Error in request', method, params, err);
    deferred.reject(err);
  });

  return deferred.promise;
};

exports.call = callApi;

// require('./lib/api.js').call('https://davidstage.textalk.se/backend/jsonrpc/v1/?webshop=11011','Article.list',[true,{ limit: 1}])
