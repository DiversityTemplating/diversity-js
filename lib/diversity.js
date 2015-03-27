/* global Buffer, exports */
var http  = require('q-io/http');
var reqId = 1;
var Q     = require('q');

var BACKEND_URL = 'https://api.diversity.io/';


var callDiversity = function(path) {

  var url = BACKEND_URL + path;


  var request = {
    url: url,
    charset: 'UTF-8',
    method: 'GET'
  };
  console.log('Doing req', url);
  var start = Date.now();
  return http.request(request).then(function(response) {
    if (response.status !== 200) {
      console.log('Not 200', url);
      return Q.reject(response);
    }

    return response.body.read().then(function(r) {
      console.log(path + ' took ', Date.now() - start);
      return r;
    });
  });
};

exports.get = callDiversity;

exports.getDiveristyJson = function(name, version) {
  return callDiversity('components/' + name + '/' + version + '/').then(function(data) {
    try {
      return JSON.parse(data);
    } catch (e) {
      console.log('Could not parse diversity.json');
      return Q.reject();
    }
  });
};

exports.getFile = function(name, version, path) {
  return callDiversity('components/' + name + '/' + version + '/files/' + path);
};
