/* Shared reader account for favorites. Firebase Auth tokens stay in the browser. */
(function () {
  'use strict';
  if (!window.firebase || !firebase.auth) return;
  if (!firebase.apps.length) firebase.initializeApp({
    apiKey:'YOUR_FIREBASE_WEB_API_KEY',
    authDomain:'your-firebase-project.firebaseapp.com',
    projectId:'your-firebase-project'
  });
  var auth = firebase.auth();
  var ready = new Promise(function (resolve) { auth.onAuthStateChanged(function (user) { resolve(user); }); });
  async function request(action, body) {
    await ready;
    var user = auth.currentUser;
    if (!user) throw new Error('Entre na sua conta para salvar artigos.');
    var token = await user.getIdToken();
    var response = await fetch('/api/reader/' + action, {
      method:'POST', headers:{ 'Content-Type':'application/json', Authorization:'Bearer ' + token },
      body:JSON.stringify(body || {})
    });
    var data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.message || 'Não foi possível carregar os favoritos.');
    return data;
  }
  window.LazyReader = {
    auth:auth, ready:ready, request:request,
    signInGoogle:function () { return auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()); },
    signInEmail:function (email,password) { return auth.signInWithEmailAndPassword(email,password); },
    createEmail:function (email,password) { return auth.createUserWithEmailAndPassword(email,password); },
    signOut:function () { return auth.signOut(); }
  };
})();
