'use strict';

// ── Night counter ─────────────────────────────────────────────────────────────
var currentNight = parseInt(sessionStorage.getItem('hb_night') || '1');

// ── DOM refs ──────────────────────────────────────────────────────────────────
function el(id) { return document.getElementById(id); }
var phoneScreen  = el('phone-screen');
var callScreen   = el('call-screen');
var callTextEl   = el('call-text');
var callEnter    = el('call-enter');
var nightBrief   = el('night-brief');
var briefTitle   = el('brief-title');
var briefBody    = el('brief-body');
var cluePopup    = el('clue-popup');
var cpNameEl     = el('cp-name');
var cpTextEl     = el('cp-text');
var mysteryScreen= el('mystery-screen');
var wrongScreen  = el('wrong-screen');
var nightClear   = el('night-clear');
var clearTitle   = el('clear-title');
var clearBody    = el('clear-body');
var gameoverEl   = el('gameover');
var winScreen    = el('win-screen');
var nightNumEl   = el('night-num');
var clueCountEl  = el('clue-count');
var clueTotalEl  = el('clue-total');
var msgEl        = el('message');
var solveBarEl   = el('solve-bar');

// Babylon handles (assigned in beginNight)
var canvas, engine, scene, camera, flashlight;

// Game flags
var gameOver     = false;
var gamePaused   = false;
var started      = false;
var nightDone    = false;
var cluesFound   = 0;
var allCluesFound= false;
var anyChasing   = false;
var msgTimer     = 0;
var clueT        = 0;
var keys         = {};
var camYaw       = 0;
var camPitch     = 0;
var flashOn      = true;

// ── Dispatch voice — radio effect via Web Audio ───────────────────────────────
var _callUtter  = null;
var _radioCtx   = null;
var _radioSrcs  = [];  // running buffer sources to stop later

function _mkRadioCtx() {
    if (_radioCtx) return;
    _radioCtx = new (window.AudioContext || window.webkitAudioContext)();
}
function _stopRadioCtx() {
    _radioSrcs.forEach(function(s){ try{ s.stop(); }catch(e){} });
    _radioSrcs = [];
    if (_radioCtx){ _radioCtx.close(); _radioCtx = null; }
}

// Short decaying noise burst — the "squelch" click at start/end
function _radioClick(vol) {
    if (!_radioCtx) return;
    var len = Math.floor(_radioCtx.sampleRate * 0.14);
    var buf = _radioCtx.createBuffer(1, len, _radioCtx.sampleRate);
    var d   = buf.getChannelData(0);
    for (var i=0; i<len; i++) d[i] = (Math.random()*2-1) * Math.pow(1 - i/len, 1.8);
    var src = _radioCtx.createBufferSource();
    src.buffer = buf;
    var hp = _radioCtx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 600;
    var g = _radioCtx.createGain(); g.gain.value = vol;
    src.connect(hp); hp.connect(g); g.connect(_radioCtx.destination);
    src.start(); _radioSrcs.push(src);
}

// Looping bandpass-filtered white noise — the carrier static
function _startStatic() {
    if (!_radioCtx) return;
    var rate   = _radioCtx.sampleRate;
    var buf    = _radioCtx.createBuffer(1, rate*3, rate);
    var d      = buf.getChannelData(0);
    for (var i=0; i<d.length; i++) d[i] = Math.random()*2-1;
    var src    = _radioCtx.createBufferSource();
    src.buffer = buf; src.loop = true;
    // Telephone-band bandpass (300–3400 Hz)
    var bp     = _radioCtx.createBiquadFilter();
    bp.type    = 'bandpass'; bp.frequency.value = 1100; bp.Q.value = 0.55;
    // Light high-shelf cut — old radio loses high-end
    var hs     = _radioCtx.createBiquadFilter();
    hs.type    = 'highshelf'; hs.frequency.value = 3200; hs.gain.value = -14;
    var g      = _radioCtx.createGain(); g.gain.value = 0.065;
    src.connect(bp); bp.connect(hs); hs.connect(g); g.connect(_radioCtx.destination);
    src.start(); _radioSrcs.push(src);
}

// Random crackle pops throughout the transmission
function _scheduleCrackle() {
    if (!_radioCtx) return;
    setTimeout(function() {
        if (!_radioCtx) return;
        var dur = 0.03 + Math.random()*0.07;
        var len = Math.floor(_radioCtx.sampleRate * dur);
        var buf = _radioCtx.createBuffer(1, len, _radioCtx.sampleRate);
        var d   = buf.getChannelData(0);
        for (var i=0; i<len; i++) d[i] = (Math.random()*2-1) * Math.exp(-i/(len*0.18));
        var src = _radioCtx.createBufferSource(); src.buffer = buf;
        var g   = _radioCtx.createGain(); g.gain.value = 0.2 + Math.random()*0.45;
        src.connect(g); g.connect(_radioCtx.destination);
        src.start();
        _scheduleCrackle();
    }, 600 + Math.random()*2000);
}

function speakDispatch(text) {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();

    // Radio open
    if (window.AudioContext || window.webkitAudioContext) {
        _mkRadioCtx();
        _radioClick(0.75);
        setTimeout(function(){ _startStatic(); _scheduleCrackle(); }, 180);
    }

    _callUtter = new SpeechSynthesisUtterance(text);
    _callUtter.rate   = 0.82;   // slightly slow — deliberate, authoritative
    _callUtter.pitch  = 0.68;   // low voice
    _callUtter.volume = 1.0;

    function _pick(voices) {
        // Windows: David/Mark/Guy sound most natural. Google UK Male is also good.
        return voices.find(function(v){ return /microsoft\s*(david|mark|guy)/i.test(v.name); })
            || voices.find(function(v){ return /google.*uk.*male/i.test(v.name); })
            || voices.find(function(v){ return v.lang==='en-US' && !/zira|karen|samantha|victoria|female/i.test(v.name); })
            || voices.find(function(v){ return v.lang.startsWith('en'); })
            || null;
    }

    // Radio close after speech finishes
    _callUtter.onend = function() {
        setTimeout(function(){ if(_radioCtx) _radioClick(0.5); }, 250);
        setTimeout(function(){ _stopRadioCtx(); }, 900);
    };

    var voices = window.speechSynthesis.getVoices();
    if (voices.length) {
        var v = _pick(voices); if(v) _callUtter.voice = v;
        window.speechSynthesis.speak(_callUtter);
    } else {
        window.speechSynthesis.onvoiceschanged = function() {
            window.speechSynthesis.onvoiceschanged = null;
            var v = _pick(window.speechSynthesis.getVoices()); if(v) _callUtter.voice = v;
            window.speechSynthesis.speak(_callUtter);
        };
    }
}
function stopDispatch() {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    _callUtter = null;
    _stopRadioCtx();
}

// ── String data ───────────────────────────────────────────────────────────────
var CALL_TEXT = "Detective.\n\nThe Hargrove family has been missing for 72 hours.\nFour people — father, mother, two children.\nNo signs of a struggle. No blood.\nNeighbors reported lights at odd hours. Sounds.\n\nLocal PD won't go in. You will.\n\nFind evidence. Figure out what happened to them.\nThree nights. That's what we're giving you.\n\nAnd detective —\ndon't let it know you're there.";

var BRIEFS = [
    { title:'NIGHT 1', body:"The family vanished three days ago.\nYou don't know how. You don't know why.\n\nGo in. Collect what you find.\nOne thing already patrols the halls." },
    { title:'NIGHT 2', body:"You have evidence. Not enough.\n\nA second presence has been reported\nin the west rooms.\n\nReturn. Find what remains." },
    { title:'NIGHT 3', body:"You're close.\nTwo more clues. Then you solve it.\n\nAll three are inside now.\n\nDo not stop moving." }
];
var ENTER_MSGS = [
    "Search carefully. It patrols close.",
    "Two are inside now. Watch the side rooms.",
    "Final night. Three of them. Find the truth."
];
var NIGHT_CLUES = [
    [
        { pos:{x:-18,z:-22}, name:'Christmas Photograph', room:'Living Room',
          text:'The Hargrove family — last Christmas.\nA framed photo from the mantel.\n\nOn the back, in faded ink:\n\n"Happy days above. Dark days below."\n\nA strange thing to write on a family portrait.' },
        { pos:{x:18, z:-22}, name:'Kitchen Notepad', room:'Kitchen',
          text:'A grocery list on the counter. Milk. Bread. Eggs.\n\nBelow the groceries, in shaking handwriting:\n\n"The door under the rug — do NOT open. DO NOT."\n\nThe pen tore through the paper on those last two words.' }
    ],
    [
        { pos:{x:-18,z:22},  name:"Father's Journal", room:'Study',
          text:'"Oct 31\n\nWe hear them again. Below us.\nHeavy footsteps. From the basement we keep locked.\n\nWe are not going down there.\nMargaret agrees. The children don\'t know.\n\nOct 31 — later\n\nIt was quiet for an hour.\nThen it knocked back."' },
        { pos:{x:18, z:22},  name:'Voice Memo Transcript', room:'Master Bedroom',
          text:'A cracked phone on the nightstand.\nLast voice memo, auto-transcribed:\n\n"…can\'t get the door open from inside…\nwe\'ve been here for two days…\nkids are with me… it\'s in the walls above us…\nplease… the basement… someone find us—"\n\n[Recording ends. 3:47 AM]' }
    ],
    [
        { pos:{x:0,  z:26},  name:'Scratched Message', room:'North Hallway',
          text:'Someone scratched words into the wallpaper\nnear the top of the north wall.\n\n"WE ARE BELOW"\n\nDone with fingernails.\nDeep grooves. Desperate.' },
        { pos:{x:24, z:-26}, name:'The Trapdoor', room:'Kitchen Corner',
          text:'You pull back the rug in the kitchen corner.\n\nA heavy trapdoor with a padlock,\nslightly ajar at one corner.\n\nYou press your ear to the wood.\n\nBreathing. Slow and close.\n\nSomeone is down there.' }
    ]
];

// ── Typewriter ────────────────────────────────────────────────────────────────
var _typeIv = null;
function typeText(domEl, text, ms, cb) {
    if (_typeIv) { clearInterval(_typeIv); _typeIv = null; }
    domEl.textContent = '';
    var i = 0;
    _typeIv = setInterval(function() {
        domEl.textContent += text[i++];
        if (i >= text.length) { clearInterval(_typeIv); _typeIv = null; if (cb) cb(); }
    }, ms);
}
function skipType(domEl, text, cb) {
    if (_typeIv) { clearInterval(_typeIv); _typeIv = null; }
    domEl.textContent = text;
    if (cb) cb();
}

// ── UI init ───────────────────────────────────────────────────────────────────
nightNumEl.textContent  = currentNight;
clueTotalEl.textContent = '2';
clueCountEl.textContent = '0';

// ── Intro state machine ───────────────────────────────────────────────────────
var ISTATE = 'home';
// phoneScreen starts hidden; home screen shows first
phoneScreen.classList.add('hidden');
if (currentNight > 1) {
    el('home-night-badge').classList.remove('hidden');
    el('home-night-num').textContent = currentNight;
    el('home-btn').textContent = 'Continue Investigation';
}

// ── Master click handler (capture phase — before Babylon) ─────────────────────
document.addEventListener('click', function(e) {
    switch (ISTATE) {
        case 'home':
            el('home-screen').classList.add('hidden');
            if (currentNight === 1) {
                phoneScreen.classList.remove('hidden');
                ISTATE = 'phone';
            } else {
                var bh = BRIEFS[currentNight-1];
                briefTitle.textContent = bh.title;
                briefBody.textContent  = bh.body;
                nightBrief.classList.remove('hidden');
                ISTATE = 'brief';
            }
            return;
        case 'phone':
            phoneScreen.classList.add('hidden');
            callScreen.classList.remove('hidden');
            ISTATE = 'call';
            speakDispatch(CALL_TEXT);
            typeText(callTextEl, CALL_TEXT, 22, function() {
                callEnter.classList.remove('hidden');
                ISTATE = 'call_done';
            });
            return;
        case 'call':
            stopDispatch();
            skipType(callTextEl, CALL_TEXT, function() {
                callEnter.classList.remove('hidden');
                ISTATE = 'call_done';
            });
            return;
        case 'call_done': {
            stopDispatch();
            callScreen.classList.add('hidden');
            var b = BRIEFS[currentNight-1];
            briefTitle.textContent = b.title;
            briefBody.textContent  = b.body;
            nightBrief.classList.remove('hidden');
            ISTATE = 'brief';
            return;
        }
        case 'brief':
            nightBrief.classList.add('hidden');
            ISTATE = 'game';
            beginNight();
            return;
        case 'clue_popup':
            cluePopup.classList.add('hidden');
            gamePaused = false;
            if (allCluesFound) solveBarEl.classList.remove('hidden');
            ISTATE = 'game';
            return;
        case 'night_clear':
            sessionStorage.setItem('hb_night', currentNight+1);
            location.reload();
            return;
        case 'tbc':
            sessionStorage.removeItem('hb_night');
            location.reload();
            return;
        case 'win': case 'wrong': case 'gameover':
            location.reload();
            return;
        case 'game':
            if (canvas && !gameOver && !gamePaused) canvas.requestPointerLock();
            return;
    }
}, true);

// ── Audio ─────────────────────────────────────────────────────────────────────
var audioCtx = null, chaseGain = null, chaseOscs = [];
var heartGain = null, heartTimer = null;
var lastStep = 0, growlTimer = 0;

function initAudio() {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch(e) { audioCtx = null; }
}
function startAmbient() {
    if (!audioCtx) return;
    var g = audioCtx.createGain(); g.gain.value = 0.06; g.connect(audioCtx.destination);
    [[55,0.5],[82.5,0.15],[27.5,0.22],[110,0.07]].forEach(function(p) {
        var o=audioCtx.createOscillator(), og=audioCtx.createGain();
        o.frequency.value=p[0]; o.type='sine'; og.gain.value=p[1];
        o.connect(og); og.connect(g); o.start();
    });
    // Occasional creak
    function creak() {
        if (!audioCtx) return;
        var dur=0.6+Math.random()*0.8;
        var o=audioCtx.createOscillator(), g2=audioCtx.createGain();
        o.frequency.value=120+Math.random()*80; o.type='sawtooth';
        o.frequency.linearRampToValueAtTime(60+Math.random()*40, audioCtx.currentTime+dur);
        g2.gain.setValueAtTime(0,audioCtx.currentTime);
        g2.gain.linearRampToValueAtTime(0.04,audioCtx.currentTime+0.05);
        g2.gain.exponentialRampToValueAtTime(0.001,audioCtx.currentTime+dur);
        o.connect(g2); g2.connect(audioCtx.destination);
        o.start(); o.stop(audioCtx.currentTime+dur);
        setTimeout(creak, 8000+Math.random()*12000);
    }
    setTimeout(creak, 5000+Math.random()*8000);
    startHorrorAtmosphere();
}
function startChase() {
    if (!audioCtx||chaseGain) return;
    chaseGain=audioCtx.createGain();
    chaseGain.gain.setValueAtTime(0,audioCtx.currentTime);
    chaseGain.gain.linearRampToValueAtTime(0.15,audioCtx.currentTime+0.6);
    chaseGain.connect(audioCtx.destination);
    [110,155,220].forEach(function(f){
        var o=audioCtx.createOscillator(),og=audioCtx.createGain();
        o.frequency.value=f; o.type='sawtooth'; og.gain.value=0.28;
        o.connect(og); og.connect(chaseGain); o.start(); chaseOscs.push(o);
    });
}
function stopChase() {
    if (!chaseGain) return;
    var ctx=audioCtx,g=chaseGain,os=chaseOscs.slice();
    chaseGain=null; chaseOscs=[];
    g.gain.linearRampToValueAtTime(0,ctx.currentTime+0.4);
    setTimeout(function(){os.forEach(function(o){try{o.stop();}catch(e){}});},500);
}
function playCaught() {
    if (!audioCtx) return;
    var n=audioCtx.sampleRate*2, buf=audioCtx.createBuffer(1,n,audioCtx.sampleRate);
    var d=buf.getChannelData(0);
    for(var i=0;i<n;i++) d[i]=(Math.random()*2-1)*0.6*Math.exp(-i/audioCtx.sampleRate*2);
    var src=audioCtx.createBufferSource(),g=audioCtx.createGain();
    g.gain.value=0.8; src.buffer=buf; src.connect(g); g.connect(audioCtx.destination); src.start();
}

// ── Per-monster jumpscare audio ────────────────────────────────────────────────
function playJumpscareSFX(idx) {
    if (!audioCtx) return;
    var t0 = audioCtx.currentTime;
    if (idx === 0) {
        // STALKER — piercing high shriek, rising then crashing down
        var o1=audioCtx.createOscillator(), g1=audioCtx.createGain();
        o1.type='sawtooth';
        o1.frequency.setValueAtTime(1600,t0);
        o1.frequency.linearRampToValueAtTime(2900,t0+0.35);
        o1.frequency.exponentialRampToValueAtTime(400,t0+1.6);
        g1.gain.setValueAtTime(0.001,t0);
        g1.gain.linearRampToValueAtTime(0.85,t0+0.04);
        g1.gain.exponentialRampToValueAtTime(0.001,t0+1.6);
        o1.connect(g1); g1.connect(audioCtx.destination);
        o1.start(t0); o1.stop(t0+1.6);
        // Noise burst layered under
        var nn=Math.floor(audioCtx.sampleRate*0.4), nb1=audioCtx.createBuffer(1,nn,audioCtx.sampleRate);
        var nd1=nb1.getChannelData(0);
        for(var i=0;i<nn;i++) nd1[i]=(Math.random()*2-1)*Math.exp(-i/nn*4);
        var ns1=audioCtx.createBufferSource(), ng1=audioCtx.createGain();
        ng1.gain.value=0.55; ns1.buffer=nb1;
        ns1.connect(ng1); ng1.connect(audioCtx.destination); ns1.start(t0);
    } else if (idx === 1) {
        // BRUTE — massive low-end slam + guttural roar
        var o2=audioCtx.createOscillator(), g2=audioCtx.createGain();
        o2.type='sawtooth';
        o2.frequency.setValueAtTime(90,t0);
        o2.frequency.exponentialRampToValueAtTime(38,t0+0.8);
        g2.gain.setValueAtTime(0.001,t0);
        g2.gain.linearRampToValueAtTime(1.0,t0+0.02);
        g2.gain.exponentialRampToValueAtTime(0.001,t0+1.2);
        o2.connect(g2); g2.connect(audioCtx.destination);
        o2.start(t0); o2.stop(t0+1.2);
        // Sub sine
        var o2b=audioCtx.createOscillator(), g2b=audioCtx.createGain();
        o2b.type='sine'; o2b.frequency.value=50;
        g2b.gain.setValueAtTime(0.001,t0);
        g2b.gain.linearRampToValueAtTime(0.9,t0+0.015);
        g2b.gain.exponentialRampToValueAtTime(0.001,t0+0.7);
        o2b.connect(g2b); g2b.connect(audioCtx.destination);
        o2b.start(t0); o2b.stop(t0+0.7);
        // Noise impact thud
        var nm=Math.floor(audioCtx.sampleRate*0.6), nb2=audioCtx.createBuffer(1,nm,audioCtx.sampleRate);
        var nd2=nb2.getChannelData(0);
        for(var j=0;j<nm;j++) nd2[j]=(Math.random()*2-1)*Math.exp(-j/(audioCtx.sampleRate*0.15));
        var ns2=audioCtx.createBufferSource(), ng2=audioCtx.createGain();
        ng2.gain.value=0.75; ns2.buffer=nb2;
        ns2.connect(ng2); ng2.connect(audioCtx.destination); ns2.start(t0);
    } else {
        // WRAITH — warbling supernatural wail with high-pass noise
        var lfo=audioCtx.createOscillator(), lfoG=audioCtx.createGain();
        lfo.frequency.value=6; lfoG.gain.value=280;
        lfo.connect(lfoG);
        var o3=audioCtx.createOscillator(), g3=audioCtx.createGain();
        o3.type='sine';
        o3.frequency.setValueAtTime(550,t0);
        o3.frequency.linearRampToValueAtTime(800,t0+0.5);
        lfoG.connect(o3.frequency);
        g3.gain.setValueAtTime(0.001,t0);
        g3.gain.linearRampToValueAtTime(0.8,t0+0.07);
        g3.gain.exponentialRampToValueAtTime(0.001,t0+2.0);
        o3.connect(g3); g3.connect(audioCtx.destination);
        lfo.start(t0); o3.start(t0); lfo.stop(t0+2); o3.stop(t0+2);
        // Filtered high-end screech
        var nw=Math.floor(audioCtx.sampleRate*2), nb3=audioCtx.createBuffer(1,nw,audioCtx.sampleRate);
        var nd3=nb3.getChannelData(0);
        for(var k=0;k<nw;k++) nd3[k]=(Math.random()*2-1)*0.18*Math.exp(-k/(audioCtx.sampleRate*1.2));
        var ns3=audioCtx.createBufferSource(), hp=audioCtx.createBiquadFilter(), ng3=audioCtx.createGain();
        hp.type='highpass'; hp.frequency.value=2200; ng3.gain.value=0.45;
        ns3.buffer=nb3; ns3.connect(hp); hp.connect(ng3); ng3.connect(audioCtx.destination); ns3.start(t0);
    }
}

// ── Atmospheric horror sounds ──────────────────────────────────────────────────
function playDistantWail() {
    if (!audioCtx) return;
    var t0=audioCtx.currentTime;
    var lfo=audioCtx.createOscillator(), lfoG=audioCtx.createGain();
    lfo.frequency.value=4.8; lfoG.gain.value=58;
    lfo.connect(lfoG);
    var osc=audioCtx.createOscillator(); osc.type='sawtooth';
    osc.frequency.setValueAtTime(360,t0);
    osc.frequency.linearRampToValueAtTime(590,t0+0.38);
    osc.frequency.linearRampToValueAtTime(780,t0+0.80);
    osc.frequency.linearRampToValueAtTime(480,t0+1.45);
    osc.frequency.linearRampToValueAtTime(210,t0+2.20);
    lfoG.connect(osc.frequency);
    var bp=audioCtx.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=1100; bp.Q.value=1.3;
    var g=audioCtx.createGain();
    g.gain.setValueAtTime(0,t0);
    g.gain.linearRampToValueAtTime(0.10,t0+0.28);
    g.gain.setValueAtTime(0.10,t0+1.55);
    g.gain.exponentialRampToValueAtTime(0.001,t0+2.4);
    osc.connect(bp); bp.connect(g); g.connect(audioCtx.destination);
    lfo.start(t0); osc.start(t0); lfo.stop(t0+2.5); osc.stop(t0+2.5);
}

function playWhisper() {
    if (!audioCtx) return;
    var t0=audioCtx.currentTime;
    var n=Math.floor(audioCtx.sampleRate*1.9);
    var buf=audioCtx.createBuffer(1,n,audioCtx.sampleRate);
    var d=buf.getChannelData(0);
    for (var i=0;i<n;i++) d[i]=Math.random()*2-1;
    var src=audioCtx.createBufferSource();
    var hp=audioCtx.createBiquadFilter(); hp.type='highpass'; hp.frequency.value=900;
    var lp=audioCtx.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=3400;
    var g=audioCtx.createGain();
    // Patterned amplitude simulates speech syllables
    g.gain.setValueAtTime(0,t0);
    g.gain.linearRampToValueAtTime(0.08,t0+0.12);
    g.gain.linearRampToValueAtTime(0.02,t0+0.36);
    g.gain.linearRampToValueAtTime(0.09,t0+0.58);
    g.gain.linearRampToValueAtTime(0.01,t0+0.82);
    g.gain.linearRampToValueAtTime(0.08,t0+1.00);
    g.gain.linearRampToValueAtTime(0.02,t0+1.22);
    g.gain.linearRampToValueAtTime(0.07,t0+1.40);
    g.gain.exponentialRampToValueAtTime(0.001,t0+1.9);
    src.buffer=buf; src.connect(hp); hp.connect(lp); lp.connect(g); g.connect(audioCtx.destination);
    src.start(t0);
}

function playFootstepsNear() {
    if (!audioCtx) return;
    function step(delay) {
        var t0=audioCtx.currentTime+delay;
        var n=Math.floor(audioCtx.sampleRate*0.22);
        var buf=audioCtx.createBuffer(1,n,audioCtx.sampleRate);
        var d=buf.getChannelData(0);
        for (var i=0;i<n;i++) d[i]=(Math.random()*2-1)*Math.exp(-i/(audioCtx.sampleRate*0.032));
        var src=audioCtx.createBufferSource();
        var lp=audioCtx.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=150;
        var g=audioCtx.createGain(); g.gain.value=0.70;
        src.buffer=buf; src.connect(lp); lp.connect(g); g.connect(audioCtx.destination); src.start(t0);
        var clk=audioCtx.createOscillator(), cg=audioCtx.createGain();
        clk.type='sine'; clk.frequency.value=82;
        cg.gain.setValueAtTime(0.32,t0); cg.gain.exponentialRampToValueAtTime(0.001,t0+0.065);
        clk.connect(cg); cg.connect(audioCtx.destination); clk.start(t0); clk.stop(t0+0.07);
    }
    step(0); step(0.58); step(1.13); step(1.68);
}

function playWallScratch() {
    if (!audioCtx) return;
    var t0=audioCtx.currentTime;
    function scratch(offset,dur) {
        var n=Math.floor(audioCtx.sampleRate*dur);
        var buf=audioCtx.createBuffer(1,n,audioCtx.sampleRate);
        var d=buf.getChannelData(0);
        for (var i=0;i<n;i++) d[i]=Math.random()*2-1;
        var src=audioCtx.createBufferSource();
        var bp=audioCtx.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=3900+Math.random()*1000; bp.Q.value=10;
        var g=audioCtx.createGain(); var ta=t0+offset;
        g.gain.setValueAtTime(0.001,ta);
        g.gain.linearRampToValueAtTime(0.16,ta+0.015);
        g.gain.exponentialRampToValueAtTime(0.001,ta+dur);
        src.buffer=buf; src.connect(bp); bp.connect(g); g.connect(audioCtx.destination); src.start(ta);
    }
    scratch(0,0.17); scratch(0.22,0.14); scratch(0.40,0.20); scratch(0.64,0.15); scratch(0.85,0.23);
}

function playBreathingBehind() {
    if (!audioCtx) return;
    var t0=audioCtx.currentTime;
    function breath(offset,pitchHz) {
        var dur=0.58+Math.random()*0.14;
        var n=Math.floor(audioCtx.sampleRate*dur);
        var buf=audioCtx.createBuffer(1,n,audioCtx.sampleRate);
        var d=buf.getChannelData(0);
        for (var i=0;i<n;i++) d[i]=Math.random()*2-1;
        var src=audioCtx.createBufferSource();
        var bp=audioCtx.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=pitchHz; bp.Q.value=2.8;
        var g=audioCtx.createGain(); var ta=t0+offset;
        g.gain.setValueAtTime(0,ta);
        g.gain.linearRampToValueAtTime(0.11,ta+dur*0.35);
        g.gain.exponentialRampToValueAtTime(0.001,ta+dur);
        src.buffer=buf; src.connect(bp); bp.connect(g); g.connect(audioCtx.destination); src.start(ta);
    }
    breath(0,560); breath(0.82,370); breath(1.65,580); breath(2.48,355);
}

function playChildLaugh() {
    if (!audioCtx) return;
    var t0=audioCtx.currentTime;
    [0,0.24,0.46,0.70].forEach(function(dt) {
        var osc=audioCtx.createOscillator();
        var ws=audioCtx.createWaveShaper();
        var lp=audioCtx.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=2000;
        var g=audioCtx.createGain();
        var curve=new Float32Array(512);
        for (var i=0;i<512;i++){var x=(i*2)/512-1; curve[i]=Math.max(-0.55,Math.min(0.55,x*9))/0.55;}
        ws.curve=curve;
        osc.type='sawtooth'; osc.frequency.value=205+Math.random()*45;
        var ta=t0+dt;
        g.gain.setValueAtTime(0.001,ta);
        g.gain.linearRampToValueAtTime(0.12,ta+0.035);
        g.gain.exponentialRampToValueAtTime(0.001,ta+0.20);
        osc.connect(ws); ws.connect(lp); lp.connect(g); g.connect(audioCtx.destination);
        osc.start(ta); osc.stop(ta+0.22);
    });
}

function playDoorBang() {
    if (!audioCtx) return;
    var t0=audioCtx.currentTime;
    // Body thud
    var n=Math.floor(audioCtx.sampleRate*0.5);
    var buf=audioCtx.createBuffer(1,n,audioCtx.sampleRate);
    var d=buf.getChannelData(0);
    for (var i=0;i<n;i++) d[i]=(Math.random()*2-1)*Math.exp(-i/(audioCtx.sampleRate*0.055));
    var src=audioCtx.createBufferSource();
    var lp=audioCtx.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=110;
    var g=audioCtx.createGain(); g.gain.value=0.95;
    src.buffer=buf; src.connect(lp); lp.connect(g); g.connect(audioCtx.destination); src.start(t0);
    // Mid crack
    var o2=audioCtx.createOscillator(), g2=audioCtx.createGain();
    o2.type='sawtooth';
    o2.frequency.setValueAtTime(230,t0); o2.frequency.exponentialRampToValueAtTime(50,t0+0.13);
    g2.gain.setValueAtTime(0.001,t0); g2.gain.linearRampToValueAtTime(0.75,t0+0.01); g2.gain.exponentialRampToValueAtTime(0.001,t0+0.20);
    o2.connect(g2); g2.connect(audioCtx.destination); o2.start(t0); o2.stop(t0+0.22);
    // High rattle
    var n3=Math.floor(audioCtx.sampleRate*0.38);
    var buf3=audioCtx.createBuffer(1,n3,audioCtx.sampleRate);
    var d3=buf3.getChannelData(0);
    for (var j=0;j<n3;j++) d3[j]=(Math.random()*2-1)*0.24*Math.exp(-j/(audioCtx.sampleRate*0.28));
    var src3=audioCtx.createBufferSource();
    var hp3=audioCtx.createBiquadFilter(); hp3.type='highpass'; hp3.frequency.value=700;
    var g3=audioCtx.createGain(); g3.gain.value=0.28;
    src3.buffer=buf3; src3.connect(hp3); hp3.connect(g3); g3.connect(audioCtx.destination);
    src3.start(t0+0.07);
}

// ── Random scare scheduler ────────────────────────────────────────────────────
function startHorrorAtmosphere() {
    var SCARES = [
        playDistantWail, playDistantWail,
        playWhisper,
        playFootstepsNear, playFootstepsNear,
        playWallScratch,
        playBreathingBehind,
        playChildLaugh,
        playDoorBang
    ];
    function nextScare() {
        if (ISTATE==='game' && !gameOver && !gamePaused) {
            SCARES[Math.floor(Math.random()*SCARES.length)]();
        }
        setTimeout(nextScare, 20000+Math.random()*35000);
    }
    setTimeout(nextScare, 14000+Math.random()*16000);
}

// ── Per-monster face drawn to canvas ──────────────────────────────────────────
function drawJumpscare(cv, idx) {
    var W=cv.width, H=cv.height, cx=W/2;
    var c=cv.getContext('2d');
    c.clearRect(0,0,W,H);

    if (idx===0) {
        // STALKER — narrow towering silhouette, ice-blue eyes
        c.fillStyle='#030206'; c.fillRect(0,0,W,H);
        // Face silhouette (tall narrow oval)
        c.fillStyle='#0b0912';
        c.beginPath(); c.ellipse(cx,H*0.30,W*0.12,H*0.30,0,0,Math.PI*2); c.fill();
        // Body
        c.fillStyle='#07050f';
        c.beginPath(); c.ellipse(cx,H*0.68,W*0.08,H*0.22,0,0,Math.PI*2); c.fill();
        // Long dragging arms to screen edges
        c.fillStyle='#060410';
        c.beginPath();
        c.moveTo(cx-W*0.07,H*0.44); c.lineTo(W*0.02,H*0.85); c.lineTo(0,H*0.90);
        c.lineTo(0,H*0.78); c.lineTo(cx-W*0.04,H*0.58); c.closePath(); c.fill();
        c.beginPath();
        c.moveTo(cx+W*0.07,H*0.44); c.lineTo(W*0.98,H*0.85); c.lineTo(W,H*0.90);
        c.lineTo(W,H*0.78); c.lineTo(cx+W*0.04,H*0.58); c.closePath(); c.fill();
        // Ice-blue glowing eyes
        [-0.055,0.055].forEach(function(ox){
            var ex=cx+ox*W, ey=H*0.255;
            var eg=c.createRadialGradient(ex,ey,0,ex,ey,W*0.045);
            eg.addColorStop(0,'rgba(200,225,255,1)'); eg.addColorStop(0.3,'rgba(100,160,255,0.75)'); eg.addColorStop(1,'rgba(50,90,220,0)');
            c.fillStyle=eg; c.beginPath(); c.arc(ex,ey,W*0.045,0,Math.PI*2); c.fill();
            c.fillStyle='rgba(240,248,255,0.98)'; c.beginPath(); c.arc(ex,ey,W*0.010,0,Math.PI*2); c.fill();
        });

    } else if (idx===1) {
        // BRUTE — wide flat face filling screen, huge amber eyes, jagged teeth
        c.fillStyle='#060101'; c.fillRect(0,0,W,H);
        // Massive wide face
        c.fillStyle='#110503';
        c.beginPath(); c.ellipse(cx,H*0.40,W*0.54,H*0.50,0,0,Math.PI*2); c.fill();
        // Dark body below
        c.fillStyle='#090201'; c.fillRect(0,H*0.70,W,H*0.30);
        // Large amber eyes spread wide
        [-0.23,0.23].forEach(function(ox){
            var ex=cx+ox*W, ey=H*0.33;
            var eg=c.createRadialGradient(ex,ey,0,ex,ey,W*0.115);
            eg.addColorStop(0,'rgba(255,185,0,1)'); eg.addColorStop(0.3,'rgba(230,100,0,0.85)'); eg.addColorStop(1,'rgba(160,30,0,0)');
            c.fillStyle=eg; c.beginPath(); c.ellipse(ex,ey,W*0.115,H*0.09,0,0,Math.PI*2); c.fill();
            c.fillStyle='#080101'; c.beginPath(); c.ellipse(ex,ey,W*0.028,H*0.044,0,0,Math.PI*2); c.fill();
        });
        // Jagged teeth row
        var tx=W*0.22, tw=W*0.56, ty=H*0.62;
        c.fillStyle='#c8bfb0';
        c.beginPath(); c.moveTo(tx,ty);
        for(var ti=0;ti<=12;ti++){
            var bx=tx+(tw/12)*ti;
            c.lineTo(bx, ti%2===0 ? ty : ty-H*0.08);
        }
        c.lineTo(tx+tw,ty+H*0.05); c.lineTo(tx,ty+H*0.05); c.closePath(); c.fill();

    } else {
        // WRAITH — impossibly tall skull, close red eyes, radiating cracks
        c.fillStyle='#020104'; c.fillRect(0,0,W,H);
        // Elongated skull
        c.fillStyle='#090614';
        c.beginPath(); c.ellipse(cx,H*0.40,W*0.16,H*0.46,0,0,Math.PI*2); c.fill();
        // Purple fog halo
        var fg=c.createRadialGradient(cx,H*0.40,H*0.08,cx,H*0.40,H*0.58);
        fg.addColorStop(0,'rgba(0,0,0,0)'); fg.addColorStop(0.5,'rgba(12,4,24,0.35)'); fg.addColorStop(1,'rgba(0,0,0,0.7)');
        c.fillStyle=fg; c.fillRect(0,0,W,H);
        // Radiating skull cracks
        c.strokeStyle='rgba(55,25,80,0.65)'; c.lineWidth=1.5;
        var crk=[cx,H*0.26];
        [[cx-W*0.14,H*0.02],[cx+W*0.16,H*0.04],[cx-W*0.28,H*0.18],[cx+W*0.30,H*0.22],
         [cx-W*0.08,H*0.72],[cx+W*0.10,H*0.75]].forEach(function(end){
            c.beginPath(); c.moveTo(crk[0],crk[1]);
            c.lineTo(crk[0]+(end[0]-crk[0])*0.5+(Math.random()-0.5)*W*0.05, crk[1]+(end[1]-crk[1])*0.5+(Math.random()-0.5)*H*0.05);
            c.lineTo(end[0],end[1]); c.stroke();
        });
        // Close-set intense red eyes
        [-0.048,0.048].forEach(function(ox){
            var ex=cx+ox*W, ey=H*0.31;
            var eg=c.createRadialGradient(ex,ey,0,ex,ey,W*0.075);
            eg.addColorStop(0,'rgba(255,50,20,1)'); eg.addColorStop(0.2,'rgba(210,0,0,0.9)'); eg.addColorStop(0.55,'rgba(120,0,0,0.4)'); eg.addColorStop(1,'rgba(50,0,0,0)');
            c.fillStyle=eg; c.beginPath(); c.arc(ex,ey,W*0.075,0,Math.PI*2); c.fill();
            c.fillStyle='rgba(255,210,190,1)'; c.beginPath(); c.arc(ex,ey,W*0.013,0,Math.PI*2); c.fill();
        });
    }
}

// ── Jumpscare trigger ──────────────────────────────────────────────────────────
function triggerJumpscare(monsterIdx) {
    gameOver=true; gamePaused=true; ISTATE='gameover';
    stopChase(); stopHeartbeat();
    playJumpscareSFX(monsterIdx);
    var jsEl=el('jumpscare'), jsCv=el('js-canvas');
    jsCv.width=window.innerWidth; jsCv.height=window.innerHeight;
    drawJumpscare(jsCv, monsterIdx);
    jsEl.classList.remove('hidden');
    void jsEl.offsetWidth; // force reflow so animation restarts
    jsEl.classList.add('js-show');
    setTimeout(function(){
        jsEl.style.transition='opacity 0.45s';
        jsEl.style.opacity='0';
        setTimeout(function(){
            jsEl.classList.add('hidden'); jsEl.classList.remove('js-show');
            jsEl.style.transition=''; jsEl.style.opacity='';
            gameoverEl.classList.remove('hidden');
        },450);
    },1350);
}

// ── Final cinematic scene ──────────────────────────────────────────────────────
function drawCarForward(cv) {
    var W=cv.width, H=cv.height, c=cv.getContext('2d');
    // Night sky
    c.fillStyle='#060810'; c.fillRect(0,0,W,H);
    // Stars
    c.fillStyle='rgba(200,215,225,0.35)';
    for(var si=0;si<45;si++){
        c.beginPath();
        c.arc((Math.sin(si*7.3)*0.5+0.5)*W,(Math.sin(si*5.1)*0.5+0.5)*(H*0.44),0.8,0,Math.PI*2); c.fill();
    }
    // Road trapezoid
    var rg=c.createLinearGradient(0,H*0.48,0,H*0.72);
    rg.addColorStop(0,'#0d0f18'); rg.addColorStop(1,'#171b22');
    c.fillStyle=rg;
    c.beginPath(); c.moveTo(W*0.07,H*0.72); c.lineTo(W*0.93,H*0.72);
    c.lineTo(W*0.60,H*0.48); c.lineTo(W*0.40,H*0.48); c.closePath(); c.fill();
    // Center dashes
    c.strokeStyle='rgba(175,165,135,0.45)'; c.lineWidth=2; c.setLineDash([H*0.028,H*0.038]);
    c.beginPath(); c.moveTo(W*0.50,H*0.72); c.lineTo(W*0.50,H*0.49); c.stroke(); c.setLineDash([]);
    // Edge lines
    c.strokeStyle='rgba(150,145,120,0.3)'; c.lineWidth=1.5;
    c.beginPath(); c.moveTo(W*0.14,H*0.72); c.lineTo(W*0.42,H*0.49); c.stroke();
    c.beginPath(); c.moveTo(W*0.86,H*0.72); c.lineTo(W*0.58,H*0.49); c.stroke();
    // Tree silhouettes — left side
    for(var ti=0;ti<5;ti++){
        var tx=W*(0.02+ti*0.045), th=H*(0.34+Math.sin(ti*2.3)*0.09);
        c.fillStyle='#040608';
        c.fillRect(tx+W*0.005,H*0.72-th,W*0.012,th);
        c.beginPath(); c.arc(tx+W*0.011,H*0.72-th,W*0.017+Math.sin(ti)*W*0.003,0,Math.PI*2); c.fill();
    }
    // Tree silhouettes — right side
    for(var ti2=0;ti2<5;ti2++){
        var tx2=W*(0.98-ti2*0.045), th2=H*(0.34+Math.sin(ti2*3.1)*0.09);
        c.fillStyle='#040608';
        c.fillRect(tx2-W*0.017,H*0.72-th2,W*0.012,th2);
        c.beginPath(); c.arc(tx2-W*0.011,H*0.72-th2,W*0.017+Math.sin(ti2+1)*W*0.003,0,Math.PI*2); c.fill();
    }
    // Windshield pillars
    c.fillStyle='#070a0f';
    c.beginPath(); c.moveTo(0,0); c.lineTo(W,0); c.lineTo(W,H*0.12);
    c.quadraticCurveTo(W*0.5,H*0.20,0,H*0.12); c.closePath(); c.fill();
    c.beginPath(); c.moveTo(0,H*0.12); c.lineTo(W*0.065,H*0.72); c.lineTo(0,H*0.72); c.closePath(); c.fill();
    c.beginPath(); c.moveTo(W,H*0.12); c.lineTo(W*0.935,H*0.72); c.lineTo(W,H*0.72); c.closePath(); c.fill();
    // Rearview mirror
    c.fillStyle='#0c0e15'; c.fillRect(W*0.44,H*0.13,W*0.12,H*0.05);
    c.strokeStyle='rgba(50,55,72,0.5)'; c.lineWidth=1;
    c.strokeRect(W*0.44,H*0.13,W*0.12,H*0.05);
    // Dashboard
    var dg=c.createLinearGradient(0,H*0.72,0,H);
    dg.addColorStop(0,'#0e1016'); dg.addColorStop(1,'#080a0e');
    c.fillStyle=dg; c.fillRect(0,H*0.72,W,H*0.28);
    // Steering wheel
    c.strokeStyle='rgba(35,40,52,1)'; c.lineWidth=8;
    var wCx=W*0.38,wCy=H*0.88,wR=H*0.12;
    c.beginPath(); c.arc(wCx,wCy,wR,0,Math.PI*2); c.stroke();
    c.lineWidth=5;
    c.beginPath(); c.moveTo(wCx,wCy-wR*0.5); c.lineTo(wCx,wCy+wR*0.5); c.stroke();
    c.beginPath(); c.moveTo(wCx-wR*0.5,wCy); c.lineTo(wCx+wR*0.5,wCy); c.stroke();
    // Instrument glow
    var ig=c.createRadialGradient(W*0.38,H*0.86,0,W*0.38,H*0.86,W*0.09);
    ig.addColorStop(0,'rgba(55,38,10,0.28)'); ig.addColorStop(1,'rgba(0,0,0,0)');
    c.fillStyle=ig; c.fillRect(0,H*0.72,W,H*0.28);
    // Headlight road glow
    var hg=c.createRadialGradient(W*0.5,H*0.60,0,W*0.5,H*0.60,W*0.20);
    hg.addColorStop(0,'rgba(170,200,170,0.05)'); hg.addColorStop(1,'rgba(0,0,0,0)');
    c.fillStyle=hg; c.beginPath(); c.ellipse(W*0.5,H*0.60,W*0.20,H*0.10,0,0,Math.PI*2); c.fill();
}

function drawCarBackseat(cv) {
    var W=cv.width, H=cv.height, c=cv.getContext('2d');
    c.fillStyle='#030407'; c.fillRect(0,0,W,H);
    // Left seat back
    c.fillStyle='#07080d';
    c.beginPath(); c.moveTo(0,0); c.lineTo(W*0.32,0); c.lineTo(W*0.28,H); c.lineTo(0,H); c.closePath(); c.fill();
    c.fillStyle='#0a0c14'; c.fillRect(W*0.04,H*0.08,W*0.18,H*0.22);
    // Right seat back
    c.fillStyle='#07080d';
    c.beginPath(); c.moveTo(W,0); c.lineTo(W*0.68,0); c.lineTo(W*0.72,H); c.lineTo(W,H); c.closePath(); c.fill();
    c.fillStyle='#0a0c14'; c.fillRect(W*0.78,H*0.08,W*0.18,H*0.22);
    // Rear window
    var rwg=c.createLinearGradient(0,H*0.05,0,H*0.36);
    rwg.addColorStop(0,'#080b10'); rwg.addColorStop(1,'#040609');
    c.fillStyle=rwg; c.fillRect(W*0.30,H*0.05,W*0.40,H*0.30);
    // Backseat surface
    c.fillStyle='#050609'; c.fillRect(W*0.28,H*0.72,W*0.44,H*0.28);
    // ── Monster body ─────────────────────────────────────────────────────────
    c.fillStyle='#030205';
    c.beginPath(); c.ellipse(W*0.70,H*0.70,W*0.20,H*0.40,0.08,0,Math.PI*2); c.fill();
    c.beginPath(); c.ellipse(W*0.68,H*0.30,W*0.13,H*0.22,-0.06,0,Math.PI*2); c.fill();
    // Arm draped toward center
    c.fillStyle='#040305';
    c.beginPath();
    c.moveTo(W*0.55,H*0.54); c.quadraticCurveTo(W*0.45,H*0.68,W*0.34,H*0.80);
    c.lineTo(W*0.39,H*0.82); c.quadraticCurveTo(W*0.48,H*0.70,W*0.59,H*0.56); c.closePath(); c.fill();
    // Fingers
    c.strokeStyle='rgba(10,8,16,1)'; c.lineWidth=2;
    [0,0.022,0.042,0.060].forEach(function(ox){
        c.beginPath(); c.moveTo(W*(0.35+ox),H*0.80); c.lineTo(W*(0.33+ox),H*0.88); c.stroke();
    });
    // Dark aura
    var aura=c.createRadialGradient(W*0.68,H*0.50,H*0.04,W*0.68,H*0.50,H*0.58);
    aura.addColorStop(0,'rgba(0,0,0,0)'); aura.addColorStop(0.5,'rgba(2,1,5,0.25)'); aura.addColorStop(1,'rgba(0,0,0,0.65)');
    c.fillStyle=aura; c.fillRect(0,0,W,H);
    // Eyes — asymmetric, red glowing
    [[W*0.60,H*0.268,W*0.052],[W*0.735,H*0.244,W*0.072]].forEach(function(e,i){
        var eg=c.createRadialGradient(e[0],e[1],0,e[0],e[1],e[2]);
        eg.addColorStop(0,'rgba(240,20,8,1)'); eg.addColorStop(0.2,'rgba(190,0,0,0.88)');
        eg.addColorStop(0.55,'rgba(110,0,0,0.35)'); eg.addColorStop(1,'rgba(40,0,0,0)');
        c.fillStyle=eg; c.beginPath(); c.arc(e[0],e[1],e[2],0,Math.PI*2); c.fill();
        c.fillStyle='rgba(255,'+(i?210:180)+','+(i?195:160)+',1)';
        c.beginPath(); c.arc(e[0],e[1],W*(i?0.013:0.009),0,Math.PI*2); c.fill();
    });
}

function speakFinalVoice(text, onEnd) {
    if (!window.speechSynthesis) { if(onEnd) onEnd(); return; }
    window.speechSynthesis.cancel();
    var u=new SpeechSynthesisUtterance(text);
    u.rate=0.62; u.pitch=0.28; u.volume=1.0;
    function _pick(v){ return v.find(function(x){ return /microsoft\s*(david|mark|guy)/i.test(x.name); })
        || v.find(function(x){ return v.lang==='en-US'&&!/zira|karen|samantha|victoria|female/i.test(x.name); })
        || v.find(function(x){ return x.lang.startsWith('en'); }) || null; }
    var done=false, fb=setTimeout(function(){ if(!done){ done=true; if(onEnd) onEnd(); }},30000);
    u.onend=function(){ if(!done){ done=true; clearTimeout(fb); setTimeout(function(){ if(onEnd) onEnd(); },300); } };
    var voices=window.speechSynthesis.getVoices();
    if(voices.length){ var v=_pick(voices); if(v) u.voice=v; window.speechSynthesis.speak(u); }
    else { window.speechSynthesis.onvoiceschanged=function(){ window.speechSynthesis.onvoiceschanged=null;
        var v=_pick(window.speechSynthesis.getVoices()); if(v) u.voice=v; window.speechSynthesis.speak(u); }; }
}

function animateMirrorReveal(cv, onComplete) {
    var W=cv.width, H=cv.height, ctx=cv.getContext('2d');
    // Mirror rect — must match drawCarForward exactly
    var mx=W*0.44, my=H*0.13, mw=W*0.12, mh=H*0.05;
    var DURATION=2500, start=Date.now();
    var timer=setInterval(function(){
        var t=Math.min(1,(Date.now()-start)/DURATION);
        // Full forward view as base each frame
        drawCarForward(cv);
        // Clip to inside the mirror border
        ctx.save();
        ctx.beginPath(); ctx.rect(mx+1,my+1,mw-2,mh-2); ctx.clip();
        // Dark mirror interior (slightly different shade to look reflective)
        ctx.fillStyle='#050709'; ctx.fillRect(mx,my,mw,mh);
        // Red eye glow — appears first (t 0→0.65 → full brightness)
        var eyeT=Math.min(1,t/0.65), eyeA=eyeT*eyeT;
        if(eyeA>0.01){
            var ex1=mx+mw*0.44, ex2=mx+mw*0.56, ey=my+mh*0.42, er=mw*0.06;
            [ex1,ex2].forEach(function(ex){
                var eg=ctx.createRadialGradient(ex,ey,0,ex,ey,er*2.8);
                eg.addColorStop(0,'rgba(230,0,0,'+(eyeA*0.95)+')');
                eg.addColorStop(0.35,'rgba(160,0,0,'+(eyeA*0.5)+')');
                eg.addColorStop(1,'rgba(80,0,0,0)');
                ctx.fillStyle=eg;
                ctx.beginPath(); ctx.arc(ex,ey,er*3,0,Math.PI*2); ctx.fill();
            });
            // Bright pupil dot
            ctx.fillStyle='rgba(255,60,0,'+eyeA+')';
            [ex1,ex2].forEach(function(ex){
                ctx.beginPath(); ctx.arc(ex,ey,er*0.4,0,Math.PI*2); ctx.fill();
            });
        }
        // Dark silhouette — emerges after t=0.30
        if(t>0.30){
            var silT=Math.min(1,(t-0.30)/0.55), silA=silT*0.7;
            // Elongated skull
            ctx.fillStyle='rgba(2,2,5,'+silA+')';
            ctx.beginPath();
            ctx.ellipse(mx+mw*0.50,my+mh*0.28,mw*0.20,mh*0.55,0,0,Math.PI*2); ctx.fill();
            // Shoulders/body peeking below
            ctx.fillRect(mx+mw*0.30,my+mh*0.72,mw*0.40,mh*0.50);
        }
        ctx.restore();
        // Redraw mirror frame on top of the content
        ctx.strokeStyle='rgba(60,66,85,0.8)'; ctx.lineWidth=1.5;
        ctx.strokeRect(mx,my,mw,mh);
        if(t>=1){ clearInterval(timer); if(onComplete) onComplete(); }
    },33);
}

function triggerFinalScene() {
    gamePaused=true; ISTATE='tbc';
    stopChase(); stopHeartbeat();
    try{ document.exitPointerLock(); }catch(e){}
    try{ if(audioCtx) audioCtx.suspend(); }catch(e){}

    var sceneEl=el('final-scene'), cv=el('final-canvas');
    var overlay=el('final-overlay'), cap=el('final-caption'), tbc=el('final-tbc');
    sceneEl.classList.add('visible');
    cv.width=window.innerWidth; cv.height=window.innerHeight;
    drawCarForward(cv);

    // Audio context for this scene only
    var sctx=null;
    try{ sctx=new(window.AudioContext||window.webkitAudioContext)(); }catch(e){}

    function setOverlay(col,op,dur){
        overlay.style.transition=dur!=null?'opacity '+dur+'s ease':'none';
        overlay.style.backgroundColor=col||'#000';
        void overlay.offsetWidth;
        overlay.style.opacity=op!=null?op:1;
    }
    function knock(vol){
        if(!sctx) return;
        var t=sctx.currentTime;
        var n=Math.floor(sctx.sampleRate*0.28), buf=sctx.createBuffer(1,n,sctx.sampleRate);
        var d=buf.getChannelData(0);
        for(var i=0;i<n;i++) d[i]=(Math.random()*2-1)*Math.exp(-i/(sctx.sampleRate*0.04))*vol;
        var src=sctx.createBufferSource(),ng=sctx.createGain(); ng.gain.value=0.7;
        src.buffer=buf; src.connect(ng); ng.connect(sctx.destination); src.start(t);
        var o=sctx.createOscillator(),og=sctx.createGain(); o.type='sine'; o.frequency.value=110;
        og.gain.setValueAtTime(vol*0.5,t); og.gain.exponentialRampToValueAtTime(0.001,t+0.35);
        o.connect(og); og.connect(sctx.destination); o.start(t); o.stop(t+0.35);
    }
    function startEngine(){
        if(!sctx) return;
        var o=sctx.createOscillator(),g=sctx.createGain();
        o.type='sawtooth'; o.frequency.value=86; g.gain.value=0.038;
        o.connect(g); g.connect(sctx.destination); o.start();
        var rn=sctx.sampleRate*3, rb=sctx.createBuffer(1,rn,sctx.sampleRate), rd=rb.getChannelData(0);
        for(var ri=0;ri<rn;ri++) rd[ri]=Math.random()*2-1;
        var rs=sctx.createBufferSource(); rs.buffer=rb; rs.loop=true;
        var lp=sctx.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=140;
        var rg2=sctx.createGain(); rg2.gain.value=0.025;
        rs.connect(lp); lp.connect(rg2); rg2.connect(sctx.destination); rs.start();
    }
    function startDrone(){
        if(!sctx) return;
        var t=sctx.currentTime;
        [38,58,42].forEach(function(f,i){
            var o=sctx.createOscillator(),g=sctx.createGain();
            o.type='sine'; o.frequency.value=f;
            g.gain.setValueAtTime(0,t); g.gain.linearRampToValueAtTime(0.055-i*0.008,t+2.2);
            o.connect(g); g.connect(sctx.destination); o.start(t);
        });
    }

    // ── Timeline ──────────────────────────────────────────────────────────────
    setOverlay('#000',1);

    setTimeout(function(){ startEngine(); setOverlay('#000',0,1.3); },700);

    setTimeout(function(){ cap.textContent='2:47 AM  ·  DRIVING HOME'; cap.style.opacity='1'; },1400);
    setTimeout(function(){ cap.style.opacity='0'; },3800);

    setTimeout(function(){ knock(0.70); cv.classList.add('shake');
        setTimeout(function(){ cv.classList.remove('shake'); },360); },4600);
    setTimeout(function(){ knock(0.82); cv.classList.add('shake');
        setTimeout(function(){ cv.classList.remove('shake'); },360); },5350);
    setTimeout(function(){ knock(1.0);  cv.classList.add('shake');
        setTimeout(function(){ cv.classList.remove('shake'); },420); },5950);

    // Monster materialises in rearview mirror
    setTimeout(function(){
        animateMirrorReveal(cv, function(){
            // Fully revealed — play the Wraith scream
            playJumpscareSFX(2);
        });
    },7000);

    // Fade to black after the monster is seen
    setTimeout(function(){ setOverlay('#000',1,1.1); },10300);

    // Dark voice + drone
    setTimeout(function(){
        startDrone();
        speakFinalVoice(
            'You may have saved our puppets... but we are still the ones pulling the strings.',
            function(){
                // Fade to white
                setTimeout(function(){
                    overlay.style.transition='opacity 2.0s ease';
                    overlay.style.backgroundColor='#fff'; overlay.style.opacity='1';
                    setTimeout(function(){ tbc.style.opacity='1'; },2000);
                },1100);
            }
        );
    },11800);
}

function playClueChime() {
    if (!audioCtx) return;
    [523,659,784].forEach(function(f,i){
        var o=audioCtx.createOscillator(),g=audioCtx.createGain();
        o.frequency.value=f; o.type='sine';
        var t0=audioCtx.currentTime+i*0.12;
        g.gain.setValueAtTime(0.001,t0);
        g.gain.linearRampToValueAtTime(0.14,t0+0.04);
        g.gain.exponentialRampToValueAtTime(0.001,t0+1.2);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(t0); o.stop(t0+1.2);
    });
}
function playStep() {
    if (!audioCtx) return;
    var buf=audioCtx.createBuffer(1,Math.floor(audioCtx.sampleRate*0.09),audioCtx.sampleRate);
    var d=buf.getChannelData(0);
    for(var i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*Math.exp(-i/d.length*18)*0.5;
    var src=audioCtx.createBufferSource(),g=audioCtx.createGain(); g.gain.value=0.35;
    src.buffer=buf; src.connect(g); g.connect(audioCtx.destination); src.start();
}
function playGrowl() {
    if (!audioCtx) return;
    var o=audioCtx.createOscillator(),g=audioCtx.createGain();
    o.frequency.value=50+Math.random()*25; o.type='sawtooth';
    var t=audioCtx.currentTime;
    g.gain.setValueAtTime(0,t);
    g.gain.linearRampToValueAtTime(0.07,t+0.15);
    g.gain.exponentialRampToValueAtTime(0.001,t+1.8);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(t); o.stop(t+1.8);
}
function startHeartbeat() {
    if (!audioCtx||heartGain) return;
    heartGain=audioCtx.createGain(); heartGain.gain.value=0.4;
    heartGain.connect(audioCtx.destination);
    function beat() {
        if (!heartGain) return;
        var t=audioCtx.currentTime;
        [[0,70,0.45,0.28],[0.2,60,0.35,0.22]].forEach(function(p){
            var o=audioCtx.createOscillator(),g=audioCtx.createGain();
            o.frequency.value=p[1]; o.type='sine';
            g.gain.setValueAtTime(0,t+p[0]);
            g.gain.linearRampToValueAtTime(p[2],t+p[0]+0.04);
            g.gain.exponentialRampToValueAtTime(0.001,t+p[0]+0.35);
            o.connect(g); g.connect(heartGain);
            o.start(t+p[0]); o.stop(t+p[0]+0.4);
        });
        heartTimer=setTimeout(beat,750);
    }
    beat();
}
function stopHeartbeat() {
    if (!heartGain) return;
    clearTimeout(heartTimer); heartTimer=null;
    heartGain.gain.linearRampToValueAtTime(0,audioCtx.currentTime+0.6);
    heartGain=null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function showMessage(txt,dur) {
    msgEl.textContent=txt; msgEl.classList.add('visible'); msgTimer=dur||4;
}
function showCluePopup(clue) {
    gamePaused=true; ISTATE='clue_popup';
    cpNameEl.textContent=clue.name; cpTextEl.textContent=clue.text;
    cluePopup.classList.remove('hidden');
}
function showNightClear() {
    gamePaused=true; nightDone=true; ISTATE='night_clear';
    clearTitle.textContent='NIGHT '+currentNight+' SURVIVED';
    clearBody.textContent=[
        "Two clues recovered.\n\nReturn tomorrow night.\nIt will be waiting.",
        "Four clues. One more night.\nYou are close to the truth."
    ][currentNight-1]||'';
    nightClear.classList.remove('hidden');
}

// ── beginNight — 3D scene created here, after intro ───────────────────────────
function beginNight() {
    initAudio();
    canvas  = el('renderCanvas');
    engine  = new BABYLON.Engine(canvas, true);
    scene   = new BABYLON.Scene(engine);

    scene.clearColor        = new BABYLON.Color4(0.01,0.01,0.02,1);
    scene.collisionsEnabled = false;
    scene.fogMode           = BABYLON.Scene.FOGMODE_EXP2;
    scene.fogDensity        = 0.018;
    scene.fogColor          = new BABYLON.Color3(0.01,0.01,0.02);

    var amb=new BABYLON.HemisphericLight('amb',new BABYLON.Vector3(0,1,0),scene);
    amb.intensity=0.035; amb.diffuse=new BABYLON.Color3(0.3,0.25,0.45);
    amb.groundColor=new BABYLON.Color3(0.04,0.03,0.06);

    camera=new BABYLON.UniversalCamera('cam',new BABYLON.Vector3(0,1.6,-24),scene);
    camera.minZ=0.1; camera.applyGravity=false;

    flashlight=new BABYLON.SpotLight('flash',camera.position.clone(),
        new BABYLON.Vector3(0,0,1),Math.PI/3.2,1.4,scene);
    flashlight.diffuse=new BABYLON.Color3(1,0.93,0.78);
    flashlight.specular=new BABYLON.Color3(0.3,0.28,0.22);
    flashlight.intensity=1.6;

    scene.onBeforeRenderObservable.add(function() {
        if (!flashOn) return;
        flashlight.position.copyFrom(camera.globalPosition);
        flashlight.direction.copyFrom(camera.getForwardRay(1).direction);
        // Subtle flashlight flicker
        flashlight.intensity=1.6+Math.sin(clueT*47)*0.03+Math.sin(clueT*113)*0.02;
    });

    // ── Post-processing ───────────────────────────────────────────────────────
    var imgProc=new BABYLON.ImageProcessingPostProcess('img',1.0,camera);
    imgProc.vignetteEnabled   = true;
    imgProc.vignetteWeight    = 4.0;
    imgProc.vignetteCameraFov = 0.6;
    imgProc.vignetteColor     = new BABYLON.Color4(0,0,0,0);
    imgProc.contrast          = 1.4;
    imgProc.exposure          = 0.85;
    imgProc.colorCurvesEnabled= true;
    var curves=new BABYLON.ColorCurves();
    curves.globalSaturation   = 60;
    curves.shadowsHue         = 220;
    curves.shadowsDensity     = 20;
    imgProc.colorCurves        = curves;

    // ── Mouse look ────────────────────────────────────────────────────────────
    document.addEventListener('mousemove',function(e){
        if (!started||gamePaused||document.pointerLockElement!==canvas) return;
        camYaw  +=e.movementX*0.0022;
        camPitch+=e.movementY*0.0022;
        camPitch=Math.max(-1.1,Math.min(1.1,camPitch));
        camera.rotation.y=camYaw;
        camera.rotation.x=camPitch;
    });

    // ── Procedural textures ───────────────────────────────────────────────────
    function woodTex(name) {
        var t=new BABYLON.DynamicTexture(name,{width:512,height:512},scene,true);
        var ctx=t.getContext(), planks=10, ph=Math.floor(512/planks);
        for(var r=0;r<planks;r++){
            // Each plank has its own base tone to break up monotony
            var base=13+Math.floor(Math.random()*14)+(r%3===0?-3:r%2===0?2:0);
            for(var py=r*ph;py<Math.min((r+1)*ph-2,512);py++){
                var noise=(Math.random()-0.5)*5;
                var v=Math.max(6,base+noise);
                ctx.fillStyle='rgb('+(v|0)+','+(v*0.62|0)+','+(v*0.36|0)+')';
                ctx.fillRect(0,py,512,1);
            }
            // Dark plank gap
            ctx.fillStyle='rgb(3,2,1)';
            ctx.fillRect(0,Math.min((r+1)*ph-2,511),512,2);
            // Grain lines
            ctx.strokeStyle='rgba(0,0,0,0.22)'; ctx.lineWidth=0.8;
            for(var g=0;g<14;g++){
                var gy=r*ph+Math.random()*ph;
                ctx.beginPath(); ctx.moveTo(0,gy);
                ctx.bezierCurveTo(170,gy+(Math.random()*12-6),340,gy+(Math.random()*12-6),512,gy+(Math.random()*8-4));
                ctx.stroke();
            }
            // Occasional knot
            if(Math.random()<0.35){
                var kx=60+Math.random()*392, ky=r*ph+ph*0.3+Math.random()*ph*0.4;
                ctx.strokeStyle='rgba(0,0,0,0.38)'; ctx.lineWidth=1.5;
                for(var ki=0;ki<3;ki++){ctx.beginPath();ctx.ellipse(kx,ky,9-ki*2.5,4.5-ki*1.2,0,0,Math.PI*2);ctx.stroke();}
            }
            // Scuff mark
            if(Math.random()<0.4){
                ctx.strokeStyle='rgba(0,0,0,0.10)'; ctx.lineWidth=1;
                ctx.beginPath();
                ctx.moveTo(Math.random()*512,r*ph);
                ctx.lineTo(Math.random()*512-50,(r+1)*ph);
                ctx.stroke();
            }
        }
        t.update(); t.uScale=4; t.vScale=4; return t;
    }

    function wallTex(name) {
        var t=new BABYLON.DynamicTexture(name,{width:512,height:512},scene,true);
        var ctx=t.getContext();
        // Aged Victorian wallpaper — deep burgundy base
        ctx.fillStyle='rgb(26,14,16)'; ctx.fillRect(0,0,512,512);
        // Subtle horizontal striping (Victorian stripe wallpaper base)
        for(var si=0;si<512;si+=22){
            ctx.fillStyle='rgba(38,20,22,0.28)'; ctx.fillRect(0,si,512,11);
        }
        // Damask medallion pattern — repeating ovals with inner detail
        var mx=68, my=82;
        for(var gx=0;gx<512+mx;gx+=mx){
            for(var gy=0;gy<512+my;gy+=my){
                var ox=((gy/my)|0)%2===0?0:mx*0.5;
                ctx.strokeStyle='rgba(60,32,34,0.6)'; ctx.lineWidth=1.2;
                ctx.beginPath(); ctx.ellipse(gx+ox,gy,20,26,0,0,Math.PI*2); ctx.stroke();
                ctx.beginPath(); ctx.ellipse(gx+ox,gy,11,15,0,0,Math.PI*2); ctx.stroke();
                // Diamond flourish
                ctx.beginPath();
                ctx.moveTo(gx+ox,gy-9); ctx.lineTo(gx+ox+5,gy);
                ctx.lineTo(gx+ox,gy+9); ctx.lineTo(gx+ox-5,gy);
                ctx.closePath(); ctx.stroke();
                // Small corner dots
                ctx.fillStyle='rgba(68,36,38,0.45)';
                [[-14,0],[14,0],[0,-18],[0,18]].forEach(function(d){
                    ctx.beginPath(); ctx.arc(gx+ox+d[0],gy+d[1],2,0,Math.PI*2); ctx.fill();
                });
            }
        }
        // Water stain patches — aged and damaged
        for(var ws=0;ws<4;ws++){
            var wx=Math.random()*512, wy=Math.random()*512, wr=25+Math.random()*45;
            var wg=ctx.createRadialGradient(wx,wy,0,wx,wy,wr);
            wg.addColorStop(0,'rgba(18,12,8,0.4)'); wg.addColorStop(1,'rgba(0,0,0,0)');
            ctx.fillStyle=wg; ctx.fillRect(0,0,512,512);
        }
        // Faint vertical crease (plaster seams beneath)
        ctx.strokeStyle='rgba(0,0,0,0.07)'; ctx.lineWidth=0.6;
        for(var vc=0;vc<512;vc+=128){
            ctx.beginPath(); ctx.moveTo(vc+Math.random()*8,0); ctx.lineTo(vc+Math.random()*8,512); ctx.stroke();
        }
        t.update(); t.uScale=3; t.vScale=3; return t;
    }

    function ceilTex(name) {
        var t=new BABYLON.DynamicTexture(name,{width:512,height:512},scene,true);
        var ctx=t.getContext();
        // Aged plaster — slightly off-white base with yellowing
        ctx.fillStyle='rgb(17,15,13)'; ctx.fillRect(0,0,512,512);
        // Plaster grain variation
        for(var pi=0;pi<2500;pi++){
            var pv=(Math.random()*10)|0;
            ctx.fillStyle='rgba('+(20+pv)+','+(18+pv)+','+(15+pv)+',0.12)';
            ctx.fillRect(Math.random()*512,Math.random()*512,2+Math.random()*5,1+Math.random()*3);
        }
        // Hairline cracks
        ctx.strokeStyle='rgba(0,0,0,0.55)'; ctx.lineWidth=0.7;
        for(var cr=0;cr<10;cr++){
            var crx=80+Math.random()*352, cry=80+Math.random()*352;
            ctx.beginPath(); ctx.moveTo(crx,cry);
            for(var cs=0;cs<5+Math.floor(Math.random()*4);cs++){
                crx+=(Math.random()*36-18); cry+=(Math.random()*36-18);
                ctx.lineTo(crx,cry);
            }
            ctx.stroke();
        }
        // Water stain rings (old leak damage)
        for(var wr=0;wr<2;wr++){
            var wrx=140+Math.random()*232, wry=140+Math.random()*232;
            for(var wri=0;wri<3;wri++){
                ctx.strokeStyle='rgba(6,5,3,'+(0.45-wri*0.13)+')';
                ctx.lineWidth=2.5-wri*0.6;
                ctx.beginPath(); ctx.ellipse(wrx,wry,22+wri*18,16+wri*12,Math.random()*0.5,0,Math.PI*2); ctx.stroke();
            }
        }
        t.update(); t.uScale=5; t.vScale=5; return t;
    }

    var wTex  = woodTex('wt');
    var wpTex = wallTex('wp');
    var ctTex = ceilTex('ct');

    function wallMat(name) {
        var m=new BABYLON.StandardMaterial(name,scene);
        m.diffuseTexture=wpTex; m.specularColor=new BABYLON.Color3(0.01,0.01,0.01);
        return m;
    }
    function floorMat(name) {
        var m=new BABYLON.StandardMaterial(name,scene);
        m.diffuseTexture=wTex; m.specularColor=new BABYLON.Color3(0.06,0.04,0.03);
        return m;
    }
    function ceilMat(name) {
        var m=new BABYLON.StandardMaterial(name,scene);
        m.diffuseTexture=ctTex; m.specularColor=new BABYLON.Color3(0.01,0.01,0.01);
        return m;
    }

    // ── Geometry ──────────────────────────────────────────────────────────────
    function box(name,x,y,z,w,h,d,mat){
        var m=BABYLON.MeshBuilder.CreateBox(name,{width:w,height:h,depth:d},scene);
        m.position.set(x,y,z); if(mat) m.material=mat; m.checkCollisions=false; return m;
    }
    function colorBox(name,x,y,z,w,h,d,r,g,b){
        var mat=new BABYLON.StandardMaterial(name+'_m',scene);
        mat.diffuseColor=new BABYLON.Color3(r,g,b);
        mat.specularColor=new BABYLON.Color3(0.02,0.02,0.02);
        return box(name,x,y,z,w,h,d,mat);
    }

    // ── Furniture textures, materials & collision ──────────────────────────────
    var furBB=[], _fid=0;
    function mkTex(nm,W,H,fn){
        var t=new BABYLON.DynamicTexture(nm,{width:W,height:H},scene,true);
        fn(t.getContext(),W,H); t.update(); return t;
    }
    // Dark walnut wood
    var _tWD=mkTex('twd',256,256,function(c,W,H){
        for(var r=0;r<H;r++){var n=(Math.sin(r*0.82)*3+(Math.random()-0.5)*4)|0;
            var v=Math.max(8,28+n); c.fillStyle='rgb('+v+','+((v*0.62)|0)+','+((v*0.38)|0)+')'; c.fillRect(0,r,W,1);}
        c.strokeStyle='rgba(0,0,0,0.22)'; c.lineWidth=1;
        for(var g=0;g<15;g++){var gy=g*17+Math.random()*7; c.beginPath(); c.moveTo(0,gy);
            c.quadraticCurveTo(W/2,gy+(Math.random()-0.5)*5,W,gy+(Math.random()-0.5)*4); c.stroke();}
        c.fillStyle='rgba(0,0,0,0.38)';
        [85,170].forEach(function(y){c.fillRect(0,y,W,2);});
    }); _tWD.uScale=2; _tWD.vScale=2;
    // Medium oak wood
    var _tWM=mkTex('twm',256,256,function(c,W,H){
        for(var r=0;r<H;r++){var n=(Math.sin(r*0.75)*4+(Math.random()-0.5)*5)|0;
            var v=Math.max(12,48+n); c.fillStyle='rgb('+v+','+((v*0.65)|0)+','+((v*0.40)|0)+')'; c.fillRect(0,r,W,1);}
        c.strokeStyle='rgba(0,0,0,0.18)'; c.lineWidth=1;
        for(var g=0;g<14;g++){var gy=g*18+Math.random()*8; c.beginPath(); c.moveTo(0,gy);
            c.quadraticCurveTo(W/2,gy+(Math.random()-0.5)*6,W,gy+(Math.random()-0.5)*5); c.stroke();}
        c.fillStyle='rgba(0,0,0,0.32)'; [85,170].forEach(function(y){c.fillRect(0,y,W,2);});
    }); _tWM.uScale=2; _tWM.vScale=2;
    // Dark charcoal fabric weave
    var _tFD=mkTex('tfd',128,128,function(c,W,H){
        c.fillStyle='rgb(22,20,26)'; c.fillRect(0,0,W,H);
        c.strokeStyle='rgba(34,32,40,0.5)'; c.lineWidth=1;
        for(var i=0;i<W;i+=5){c.beginPath();c.moveTo(i,0);c.lineTo(i,H);c.stroke();}
        c.strokeStyle='rgba(14,13,17,0.4)';
        for(var j=0;j<H;j+=5){c.beginPath();c.moveTo(0,j);c.lineTo(W,j);c.stroke();}
    }); _tFD.uScale=4; _tFD.vScale=4;
    // Brown/burgundy fabric
    var _tFB=mkTex('tfb',128,128,function(c,W,H){
        c.fillStyle='rgb(40,24,20)'; c.fillRect(0,0,W,H);
        c.strokeStyle='rgba(55,34,28,0.5)'; c.lineWidth=1;
        for(var i=0;i<W;i+=5){c.beginPath();c.moveTo(i,0);c.lineTo(i,H);c.stroke();}
        c.strokeStyle='rgba(28,18,15,0.4)';
        for(var j=0;j<H;j+=5){c.beginPath();c.moveTo(0,j);c.lineTo(W,j);c.stroke();}
    }); _tFB.uScale=4; _tFB.vScale=4;
    // Brushed metal
    var _tMT=mkTex('tmt',128,256,function(c,W,H){
        for(var i=0;i<W;i++){var v=Math.max(0,70+((Math.sin(i*0.38)*9+(Math.random()-0.5)*6)|0));
            c.fillStyle='rgb('+v+','+v+','+(v+4)+')'; c.fillRect(i,0,1,H);}
        c.strokeStyle='rgba(255,255,255,0.04)';
        for(var j=0;j<9;j++){c.beginPath();c.moveTo(0,j*32);c.lineTo(W,j*32);c.stroke();}
    }); _tMT.uScale=1; _tMT.vScale=3;
    // Stone/brick
    var _tST=mkTex('tst',256,256,function(c,W,H){
        c.fillStyle='rgb(7,6,6)'; c.fillRect(0,0,W,H);
        // Irregular stone blocks — row-offset brick pattern
        var rows=8, rh=H/rows;
        for(var sr=0;sr<rows;sr++){
            var offset=(sr%2===0)?0:24;
            for(var sx=offset-40;sx<W+40;sx+=38+Math.random()*12){
                var bx=sx+(Math.random()*4-2), by=sr*rh+(Math.random()*3-1.5);
                var bwi=34+Math.random()*10, bhi=rh-3+Math.random()*3;
                var rv=(Math.random()*18-9)|0;
                c.fillStyle='rgb('+(30+rv)+','+(27+rv)+','+(22+rv)+')';
                c.fillRect(bx,by,bwi,bhi);
                // Subtle surface variation within block
                c.strokeStyle='rgba(50,44,38,0.25)'; c.lineWidth=0.5;
                c.strokeRect(bx+1,by+1,bwi-2,bhi-2);
            }
        }
        // Soot staining near top (smoke from fire rising)
        var sg=c.createLinearGradient(0,0,0,H*0.5);
        sg.addColorStop(0,'rgba(0,0,0,0.75)'); sg.addColorStop(1,'rgba(0,0,0,0)');
        c.fillStyle=sg; c.fillRect(0,0,W,H*0.5);
    }); _tST.uScale=1; _tST.vScale=2;
    // Off-white pillow fabric
    var _tPW=mkTex('tpw',128,128,function(c,W,H){
        c.fillStyle='rgb(148,144,136)'; c.fillRect(0,0,W,H);
        c.strokeStyle='rgba(126,122,116,0.4)'; c.lineWidth=2;
        for(var i=0;i<W;i+=14){c.beginPath();c.moveTo(i,0);c.lineTo(i,H);c.stroke();}
        for(var j=0;j<H;j+=14){c.beginPath();c.moveTo(0,j);c.lineTo(W,j);c.stroke();}
    }); _tPW.uScale=2; _tPW.vScale=2;

    function mDW(){var m=new BABYLON.StandardMaterial('dw'+_fid++,scene);
        m.diffuseTexture=_tWD; m.specularColor=new BABYLON.Color3(0.04,0.02,0.01); return m;}
    function mMW(){var m=new BABYLON.StandardMaterial('mw'+_fid++,scene);
        m.diffuseTexture=_tWM; m.specularColor=new BABYLON.Color3(0.05,0.03,0.01); return m;}
    function mDF(){var m=new BABYLON.StandardMaterial('df'+_fid++,scene);
        m.diffuseTexture=_tFD; m.specularColor=new BABYLON.Color3(0.01,0.01,0.01); return m;}
    function mBF(){var m=new BABYLON.StandardMaterial('bf'+_fid++,scene);
        m.diffuseTexture=_tFB; m.specularColor=new BABYLON.Color3(0.01,0.01,0.01); return m;}
    function mMT(){var m=new BABYLON.StandardMaterial('mt'+_fid++,scene);
        m.diffuseTexture=_tMT; m.specularColor=new BABYLON.Color3(0.12,0.12,0.16); m.specularPower=48; return m;}
    function mST(){var m=new BABYLON.StandardMaterial('st'+_fid++,scene);
        m.diffuseTexture=_tST; m.specularColor=new BABYLON.Color3(0.02,0.02,0.02); return m;}
    function mPW(){var m=new BABYLON.StandardMaterial('pw'+_fid++,scene);
        m.diffuseTexture=_tPW; m.specularColor=new BABYLON.Color3(0.03,0.03,0.03); return m;}

    // furBox — like box() but also registers collision AABB (pass col=false to skip)
    function furBox(nm,cx,cy,cz,w,h,d,mat,col){
        var mb=box(nm,cx,cy,cz,w,h,d,mat);
        if(col!==false) furBB.push({x1:cx-w/2-0.06,x2:cx+w/2+0.06,z1:cz-d/2-0.06,z2:cz+d/2+0.06});
        return mb;
    }

    // Shell
    box('floor', 0, 0,   0, 60,0.2,60, floorMat('fm'));
    box('ceil',  0, 4,   0, 60,0.2,60, ceilMat('cm'));
    box('wS',    0, 2, -30, 60,4, 0.4, wallMat('wSm'));
    box('wN',    0, 2,  30, 60,4, 0.4, wallMat('wNm'));
    box('wW',  -30, 2,   0, 0.4,4,60,  wallMat('wWm'));
    box('wE',   30, 2,   0, 0.4,4,60,  wallMat('wEm'));

    // Corridor walls
    var cwM=wallMat('cwm');
    box('cwW1',-5,2,-24,0.3,4,12,cwM); box('cwW2',-5,2, 1,0.3,4,22,cwM); box('cwW3',-5,2,25,0.3,4,10,cwM);
    box('cwE1', 5,2,-24,0.3,4,12,cwM); box('cwE2', 5,2, 1,0.3,4,22,cwM); box('cwE3', 5,2,25,0.3,4,10,cwM);

    // Sub-partitions
    box('kpDiv', 22,2,-26,0.3,4, 8,cwM);
    box('nookW',-24,2, 18,0.3,4,12,cwM);
    box('bathW', 12,2, 24, 14,4,0.3,cwM);

    // Door frames (at corridor openings)
    var dfC=new BABYLON.Color3(0.08,0.05,0.04);
    function doorFrame(x,z) {
        var dfM=new BABYLON.StandardMaterial('df'+x+z,scene);
        dfM.diffuseColor=dfC; dfM.specularColor=new BABYLON.Color3(0.04,0.03,0.02);
        // Top bar
        box('dft'+x+z, x,3.85,z, 0.25,0.35,8.4,dfM);
        // Side posts
        box('dfl'+x+z, x,1.9,z-4.15, 0.25,3.8,0.25,dfM);
        box('dfr'+x+z, x,1.9,z+4.15, 0.25,3.8,0.25,dfM);
    }
    doorFrame(-5,-14); doorFrame(5,-14); // south doors
    doorFrame(-5, 16); doorFrame(5, 16); // north doors

    // Baseboards
    var bbM=new BABYLON.StandardMaterial('bb',scene);
    bbM.diffuseColor=new BABYLON.Color3(0.07,0.04,0.04);
    box('bbS', 0,0.15,-29.8, 60,0.3,0.3,bbM);
    box('bbN', 0,0.15, 29.8, 60,0.3,0.3,bbM);
    box('bbW',-29.8,0.15,0, 0.3,0.3,60,bbM);
    box('bbE', 29.8,0.15,0, 0.3,0.3,60,bbM);

    // Boarded window on south wall (living room side)
    var boardM=new BABYLON.StandardMaterial('board',scene);
    boardM.diffuseColor=new BABYLON.Color3(0.10,0.07,0.05);
    box('winFrame',-18,2,-29.8, 4.4,3.4,0.3,boardM);
    box('winB1',  -18,2.1,-29.7,4.0,0.2,0.15,boardM);
    box('winB2',  -18,1.8,-29.7,4.0,0.2,0.15,boardM);
    box('winB3',  -18,2.4,-29.7,4.0,0.2,0.15,boardM);

    // Furniture — textured & with collision
    // ── LIVING ROOM (west-south: x<-5, z<-19) ───────────────────────────────
    // Fireplace + mantel on west wall, centred in the south half of the room
    furBox('fire',   -29.6,1.2,-22,  0.4,2.4,4.0,  mST(),false);
    furBox('mantel', -29.6,2.4,-22,  0.6,0.25,5.0, mDW(),false);
    // Sofa facing the fireplace (depth runs in x so the sitting side faces west)
    furBox('sofa',   -19,  0.65,-23, 1.8,1.3,5.0,  mDF());
    furBox('sofaB',  -18.1,1.05,-23, 0.3,0.8,5.0,  mDF(),false);
    // Coffee table between sofa and fireplace
    furBox('coffTab',-24,  0.4,-23,  3.0,0.8,1.8,  mDW());
    // Armchair to the north, well clear of the south doorway (doorway is z=-18 to -10)
    furBox('armChr', -22,  0.65,-20, 1.8,1.2,2.0,  mBF());
    // TV cabinet against south wall, away from centre corridor
    furBox('tvCab',  -18,  0.5,-29.5,0.4,1.0,5.0,  mDW(),false);
    // ── KITCHEN (east-south: x>5, z<-19) ────────────────────────────────────
    // Counter runs along east wall; fridge & stove are distinct pieces
    furBox('kctr',   29.6,0.6,-22,  0.4,1.2,12,   mMW(),false);
    furBox('stove',  29.6,0.6,-27,  0.4,1.4,2.2,  mMT(),false);
    furBox('fridge', 29.6,1.0,-15,  0.4,2.0,2.0,  mMT(),false);
    // Island in the kitchen proper, well south of the doorway zone
    furBox('island', 20,  0.6,-23,  4.0,1.2,2.5,  mMW());
    // Dining table + four chairs, tucked into the south-west corner of the kitchen
    furBox('dtable', 12,  0.5,-25,  4.0,1.0,2.5,  mMW());
    furBox('dch1',   9.5, 0.5,-25,  1.4,1.0,1.4,  mDW());
    furBox('dch2',  14.5, 0.5,-25,  1.4,1.0,1.4,  mDW());
    furBox('dch3',   12,  0.5,-22.8,1.4,1.0,1.4,  mDW());
    furBox('dch4',   12,  0.5,-27.2,1.4,1.0,1.4,  mDW());
    // ── STUDY (west-north: x<-5, z>12) ─────────────────────────────────────
    // Bookshelf floor-to-ceiling along the west wall
    furBox('bshelf', -29.6,1.2,24,  0.4,2.4,10,   mDW(),false);
    // Desk against the north wall
    furBox('desk',   -15,  0.5,28,  3.5,1.0,1.8,  mMW());
    furBox('deskChr',-15,  0.5,25.8,1.6,1.0,1.6,  mDF());
    // Reading chair in the south of the study, away from the north doorway wall
    furBox('rchair', -24,  0.65,16, 2.0,1.2,1.8,  mBF());
    furBox('globe',  -12,  0.6,22,  0.8,1.2,0.8,  mDW(),false);
    // ── BEDROOM (east-north: x>5, z>12) ─────────────────────────────────────
    // Bed centred in the room with headboard on the south end
    furBox('bed',    19,  0.65,22,   5.0,1.2,3.0,  mDF());
    furBox('bedHd',  19,  1.65,20.35,5.0,1.5,0.3,  mDW());
    furBox('pillow1',17,  1.25,21.3, 1.2,0.3,0.8,  mPW(),false);
    furBox('pillow2',21,  1.25,21.3, 1.2,0.3,0.8,  mPW(),false);
    furBox('nstand1',15,  0.5,21.5,  1.2,1.0,1.2,  mDW());
    furBox('nstand2',23,  0.5,21.5,  1.2,1.0,1.2,  mDW());
    // Wardrobe and dresser against east wall
    furBox('wardrob',29.6,1.5,24,   0.4,3.0,7.0,  mDW(),false);
    furBox('dresser',29.6,0.65,15,  0.4,1.3,3.0,  mMW(),false);

    // ── FIREPLACE EMBER GLOW ──────────────────────────────────────────────────
    var fireLt=new BABYLON.PointLight('fireLt',new BABYLON.Vector3(-29.2,1.5,-22),scene);
    fireLt.diffuse=new BABYLON.Color3(1.0,0.52,0.08); fireLt.specular=new BABYLON.Color3(0.5,0.25,0.04);
    fireLt.intensity=0.9; fireLt.range=24;
    var fgM=new BABYLON.StandardMaterial('fgm',scene);
    fgM.emissiveColor=new BABYLON.Color3(1.0,0.45,0.05); fgM.disableLighting=true;
    var fgSph=BABYLON.MeshBuilder.CreateSphere('fgs',{diameter:0.38,segments:6},scene);
    fgSph.position.set(-29.55,0.85,-22); fgSph.material=fgM;

    // ── CHAIR RAIL MOULDING ───────────────────────────────────────────────────
    var molM=new BABYLON.StandardMaterial('mol',scene);
    molM.diffuseColor=new BABYLON.Color3(0.10,0.07,0.05);
    molM.specularColor=new BABYLON.Color3(0.03,0.02,0.01);
    box('molS', 0,    1.02,-29.85, 60,0.10,0.10,molM);
    box('molN', 0,    1.02, 29.85, 60,0.10,0.10,molM);
    box('molW',-29.85,1.02, 0,    0.10,0.10,60, molM);
    box('molE', 29.85,1.02, 0,    0.10,0.10,60, molM);

    // ── AREA RUGS ─────────────────────────────────────────────────────────────
    var _rg1=mkTex('rg1',256,256,function(c,W,H){
        c.fillStyle='rgb(42,18,13)'; c.fillRect(0,0,W,H);
        c.strokeStyle='rgba(72,30,20,0.85)'; c.lineWidth=6; c.strokeRect(10,10,W-20,H-20);
        c.lineWidth=2; c.strokeStyle='rgba(96,48,28,0.6)'; c.strokeRect(18,18,W-36,H-36);
        for(var ri=0;ri<8;ri++) for(var rj=0;rj<8;rj++){
            if((ri+rj)%2===0){
                c.fillStyle='rgba(62,26,16,0.55)'; var rx=ri*32+16,ry=rj*32+16;
                c.beginPath(); c.moveTo(rx,ry-10); c.lineTo(rx+10,ry); c.lineTo(rx,ry+10); c.lineTo(rx-10,ry); c.closePath(); c.fill();
            }
        }
    });
    var mRG1=new BABYLON.StandardMaterial('mrg1',scene); mRG1.diffuseTexture=_rg1; mRG1.specularColor=new BABYLON.Color3(0.01,0.01,0.01);
    box('rugLR',-21,0.12,-22, 8,0.04,6, mRG1);   // living room rug under sofa+coffee table
    var _rg2=mkTex('rg2',256,256,function(c,W,H){
        c.fillStyle='rgb(16,19,28)'; c.fillRect(0,0,W,H);
        c.strokeStyle='rgba(36,40,58,0.9)'; c.lineWidth=5; c.strokeRect(8,8,W-16,H-16);
        c.strokeStyle='rgba(48,52,76,0.5)'; c.lineWidth=1.5;
        for(var ii=22;ii<W-22;ii+=24){c.beginPath();c.moveTo(ii,22);c.lineTo(ii,H-22);c.stroke();}
        for(var jj=22;jj<H-22;jj+=24){c.beginPath();c.moveTo(22,jj);c.lineTo(W-22,jj);c.stroke();}
    });
    var mRG2=new BABYLON.StandardMaterial('mrg2',scene); mRG2.diffuseTexture=_rg2; mRG2.specularColor=new BABYLON.Color3(0.01,0.01,0.01);
    box('rugBR',19,0.12,22, 8,0.04,6, mRG2);     // bedroom rug

    // ── PICTURE FRAMES ────────────────────────────────────────────────────────
    (function(){
        var fbM=new BABYLON.StandardMaterial('fbm',scene);
        fbM.diffuseColor=new BABYLON.Color3(0.07,0.04,0.02);
        fbM.specularColor=new BABYLON.Color3(0.06,0.04,0.02); fbM.specularPower=28;
        function portrait(nm){
            return mkTex(nm,96,128,function(c,W,H){
                c.fillStyle='rgb(7,6,5)'; c.fillRect(0,0,W,H);
                c.fillStyle='rgba(16,12,9,0.88)';
                c.beginPath(); c.ellipse(W*0.5,H*0.22,W*0.18,W*0.20,0,0,Math.PI*2); c.fill();
                c.fillRect(W*0.30,H*0.36,W*0.40,H*0.38);
                c.fillRect(W*0.14,H*0.38,W*0.18,H*0.22); c.fillRect(W*0.68,H*0.38,W*0.18,H*0.22);
                c.strokeStyle='rgba(0,0,0,0.42)'; c.lineWidth=0.4;
                for(var q=0;q<22;q++){c.beginPath();c.moveTo(Math.random()*W,Math.random()*H);c.lineTo(Math.random()*W,Math.random()*H);c.stroke();}
            });
        }
        function frame(nm,x,y,z,w,h,d){
            box(nm+'fr',x,y,z,w,h,d,fbM);
            var pm=new BABYLON.StandardMaterial(nm+'m',scene);
            pm.diffuseTexture=portrait(nm+'t'); pm.specularColor=new BABYLON.Color3(0.01,0.01,0.01);
            // Canvas recessed slightly inside frame
            var isZ=w>d; // frame faces z-axis if wider in x
            var cx=isZ?x:x+(x<0?0.02:-0.02), cz=isZ?z+(z<0?0.02:-0.02):z;
            box(nm+'cv',cx,y,cz, isZ?w*0.82:0.04, h*0.82, isZ?0.04:d*0.82, pm);
        }
        frame('pf1',-22,  2.2,-29.73, 1.4,1.9,0.07); // living room south wall
        frame('pf2',-29.73,2.2,-17,   0.07,1.9,1.4); // living room west wall
        frame('pf3', 29.73,2.2, 22,   0.07,1.9,1.4); // bedroom east wall
        frame('pf4',-20,  2.2, 29.73, 1.4,1.9,0.07); // study north wall
        frame('pf5',-4.83,2.2,  3,    0.07,1.6,1.2); // corridor wall, facing hallway
    })();

    // ── BOOKS ON BOOKSHELF ────────────────────────────────────────────────────
    (function(){
        var bcs=[[0.28,0.18,0.12],[0.16,0.22,0.28],[0.22,0.14,0.10],[0.24,0.22,0.14],
                  [0.18,0.24,0.16],[0.26,0.18,0.12],[0.20,0.16,0.24],[0.22,0.13,0.10]];
        var bzs=[20.0,21.1,22.2,23.3,24.5,25.5,26.6,27.6];
        for(var bi=0;bi<8;bi++){
            var bM=new BABYLON.StandardMaterial('bk'+bi,scene);
            var bc=bcs[bi]; bM.diffuseColor=new BABYLON.Color3(bc[0],bc[1],bc[2]);
            bM.specularColor=new BABYLON.Color3(0.01,0.01,0.01);
            var bh=0.82+Math.random()*0.32, bth=0.48+Math.random()*0.26;
            box('bk'+bi,-29.5,0.5+Math.floor(bi/4)*1.1,bzs[bi],0.16,bh,bth,bM);
        }
    })();

    // ── DESK LAMP ─────────────────────────────────────────────────────────────
    var dkLpM=new BABYLON.StandardMaterial('dklm',scene);
    dkLpM.diffuseColor=new BABYLON.Color3(0.08,0.06,0.04);
    box('dkLpStem',-15,1.05,27.5,  0.07,1.0,0.07, dkLpM);
    box('dkLpShade',-15,1.6,27.3, 0.44,0.24,0.34, dkLpM);
    var dkL=new BABYLON.PointLight('dkL',new BABYLON.Vector3(-15,1.4,27.3),scene);
    dkL.diffuse=new BABYLON.Color3(0.80,0.70,0.44); dkL.intensity=0.40; dkL.range=9;

    // ── BEDROOM CANDLE ────────────────────────────────────────────────────────
    var cdM=new BABYLON.StandardMaterial('cdm',scene);
    cdM.diffuseColor=new BABYLON.Color3(0.86,0.82,0.70);
    box('candle',15,1.07,21.5, 0.09,0.22,0.09, cdM);
    var cdFlM=new BABYLON.StandardMaterial('cdfl',scene);
    cdFlM.emissiveColor=new BABYLON.Color3(1.0,0.52,0.06); cdFlM.disableLighting=true;
    var cdFlSph=BABYLON.MeshBuilder.CreateSphere('cdfs',{diameter:0.07,segments:4},scene);
    cdFlSph.position.set(15,1.24,21.5); cdFlSph.material=cdFlM;
    var cdLt=new BABYLON.PointLight('cdL',new BABYLON.Vector3(15,1.26,21.5),scene);
    cdLt.diffuse=new BABYLON.Color3(1.0,0.6,0.1); cdLt.intensity=0.20; cdLt.range=5;

    // Front door — south wall center, textured & detailed
    var fdFrameM=mDW();  // dark walnut frame
    // Outer frame (pillars + lintel)
    box('fdpL', -0.92,1.95,-29.72, 0.24,3.9,0.28,fdFrameM);
    box('fdpR',  0.92,1.95,-29.72, 0.24,3.9,0.28,fdFrameM);
    box('fdTop', 0,   3.85,-29.72, 2.08,0.24,0.28,fdFrameM);
    box('fdSill',0,   0.06,-29.72, 2.08,0.12,0.28,fdFrameM); // threshold
    // Door panels (medium wood, slightly different tone)
    var fdDoorM=mMW();
    box('fdPnL',-0.26,1.85,-29.77, 0.70,3.40,0.08,fdDoorM);
    box('fdPnR', 0.26,1.85,-29.77, 0.70,3.40,0.08,fdDoorM);
    // Raised inset moulding on each panel (4 small boxes per half)
    var fdMldM=mDW();
    [-0.26,0.26].forEach(function(px){
        box('fdm1'+px, px,2.80,-29.73, 0.52,0.72,0.04,fdMldM); // upper inset
        box('fdm2'+px, px,1.55,-29.73, 0.52,1.40,0.04,fdMldM); // lower inset
    });
    // Horizontal mid-rail
    box('fdRail',0,2.28,-29.76, 1.46,0.10,0.09,fdFrameM);
    // Transom window above door (dark semi-transparent glass)
    var tranM=new BABYLON.StandardMaterial('trM',scene);
    tranM.diffuseColor=new BABYLON.Color3(0.04,0.05,0.08);
    tranM.emissiveColor=new BABYLON.Color3(0.01,0.015,0.025);
    tranM.alpha=0.65;
    box('transom',0,3.48,-29.76, 1.46,0.30,0.06,tranM);
    // Brass door knob
    var knobM=new BABYLON.StandardMaterial('knbM',scene);
    knobM.diffuseColor=new BABYLON.Color3(0.42,0.30,0.08);
    knobM.specularColor=new BABYLON.Color3(0.75,0.55,0.18); knobM.specularPower=72;
    var knob=BABYLON.MeshBuilder.CreateSphere('knob',{diameter:0.11,segments:8},scene);
    knob.position.set(0.56,1.02,-29.73); knob.material=knobM;
    var knobPlate=box('knbPl',0.60,1.02,-29.72,0.06,0.18,0.04,knobM); // backplate
    // Hinges (left side)
    var hingeM=new BABYLON.StandardMaterial('hgM',scene);
    hingeM.diffuseColor=new BABYLON.Color3(0.28,0.22,0.08);
    hingeM.specularColor=new BABYLON.Color3(0.5,0.4,0.12); hingeM.specularPower=48;
    box('hg1',-0.78,2.80,-29.73, 0.08,0.22,0.05,hingeM);
    box('hg2',-0.78,1.20,-29.73, 0.08,0.22,0.05,hingeM);
    // Exit glow plane (activates green when clues found)
    var exitGlowM=new BABYLON.StandardMaterial('egm',scene);
    exitGlowM.emissiveColor=new BABYLON.Color3(0,0,0); exitGlowM.disableLighting=true;
    var exitGlowMesh=BABYLON.MeshBuilder.CreatePlane('exitGlw',{width:1.35,height:3.3},scene);
    exitGlowMesh.position.set(0,1.85,-29.70); exitGlowMesh.material=exitGlowM;
    var exitLight=new BABYLON.PointLight('exitL',new BABYLON.Vector3(0,2.2,-28.2),scene);
    exitLight.diffuse=new BABYLON.Color3(0.2,1.0,0.3); exitLight.intensity=0; exitLight.range=9;

    // Ceiling fixtures (dead lights hanging from cord)
    var deadM=new BABYLON.StandardMaterial('dead',scene);
    deadM.diffuseColor=new BABYLON.Color3(0.06,0.05,0.04);
    function ceilFix(name,x,z){
        box(name+'cord',x,3.6,z,0.04,0.8,0.04,deadM);
        var b=BABYLON.MeshBuilder.CreateSphere(name+'blb',{diameter:0.22,segments:8},scene);
        b.position.set(x,3.15,z); b.material=deadM;
    }
    ceilFix('lf1',-17,-17); ceilFix('lf2',17,-17);
    ceilFix('lf3',-17, 22); ceilFix('lf4',17, 22);

    // Sconces with flicker tracking
    var sconceList = [];
    function sconce(x,z) {
        var l=new BABYLON.PointLight('sc'+x+'_'+z,new BABYLON.Vector3(x,2.8,z),scene);
        l.diffuse=new BABYLON.Color3(0.60,0.28,0.06);
        l.specular=new BABYLON.Color3(0.3,0.12,0.03);
        l.intensity=0.38; l.range=18;
        // Bracket
        var bM=new BABYLON.StandardMaterial('scm'+x+z,scene);
        bM.diffuseColor=new BABYLON.Color3(0.08,0.06,0.04);
        box('scBk'+x+z, x>0?x-0.12:x+0.12, 2.8, z, 0.12,0.4,0.12,bM);
        // Bulb glow
        var gb=BABYLON.MeshBuilder.CreateSphere('scGl'+x+z,{diameter:0.18,segments:6},scene);
        gb.position.set(x,2.72,z);
        var gM=new BABYLON.StandardMaterial('scGM'+x+z,scene);
        gM.emissiveColor=new BABYLON.Color3(0.9,0.5,0.1);
        gM.disableLighting=true; gb.material=gM;
        sconceList.push({light:l, base:0.38, mesh:gb, glowMat:gM});
    }
    sconce(-29,-20); sconce(29,-20);
    sconce(-29, 20); sconce(29, 20);
    sconce(0,  -28); sconce(0,   28);
    // Fireplace ember and bedroom candle — added after sconceList init
    sconceList.push({light:fireLt, base:0.9,  mesh:fgSph,   glowMat:fgM});
    sconceList.push({light:cdLt,   base:0.20, mesh:cdFlSph, glowMat:cdFlM});

    // ── Clues ─────────────────────────────────────────────────────────────────
    var activeClues=[];
    var CLUE_COLORS=[
        new BABYLON.Color3(0.90,0.78,0.20),new BABYLON.Color3(0.85,0.15,0.10),
        new BABYLON.Color3(0.30,0.55,0.90),new BABYLON.Color3(0.25,0.80,0.40),
        new BABYLON.Color3(0.85,0.50,0.10),new BABYLON.Color3(0.70,0.25,0.85)
    ];
    NIGHT_CLUES[currentNight-1].forEach(function(clue,i){
        var col=CLUE_COLORS[(currentNight-1)*2+i];
        var pivot=new BABYLON.TransformNode('clue'+i,scene);
        pivot.position.set(clue.pos.x,1.0,clue.pos.z);
        var m=BABYLON.MeshBuilder.CreateBox('cm'+i,{width:0.26,height:0.36,depth:0.04},scene);
        m.parent=pivot;
        var mat=new BABYLON.StandardMaterial('cmat'+i,scene);
        mat.diffuseColor=col; mat.emissiveColor=col.scale(0.28);
        m.material=mat;
        var l=new BABYLON.PointLight('cl'+i,new BABYLON.Vector3(clue.pos.x,1.0,clue.pos.z),scene);
        l.diffuse=col; l.intensity=0.5; l.range=4;
        activeClues.push({data:clue,pivot:pivot,light:l,collected:false});
    });

    // ── Monsters ──────────────────────────────────────────────────────────────
    var PATROL_ROUTES=[
        [new BABYLON.Vector3(0,0,22),  new BABYLON.Vector3(-20,0,24),
         new BABYLON.Vector3(-22,0,-24),new BABYLON.Vector3(0,0,-22),
         new BABYLON.Vector3(22,0,-24), new BABYLON.Vector3(22,0,24)],
        [new BABYLON.Vector3(-20,0,-22),new BABYLON.Vector3(-28,0,-20),
         new BABYLON.Vector3(-28,0,20), new BABYLON.Vector3(-20,0,22),new BABYLON.Vector3(-10,0,0)],
        [new BABYLON.Vector3(20,0,-22), new BABYLON.Vector3(28,0,-20),
         new BABYLON.Vector3(28,0,20),  new BABYLON.Vector3(20,0,22), new BABYLON.Vector3(10,0,0)]
    ];
    var MSTARTS=[{x:0,z:28},{x:-25,z:0},{x:25,z:0}];

    // Per-monster configs: [bodyColor, eyeColor, glowColor]
    var MCFG=[
        [new BABYLON.Color3(0.04,0.03,0.07), new BABYLON.Color3(0.65,0.80,1.0),  new BABYLON.Color3(0.3,0.5,1.0)],  // Stalker – charcoal/purple, ice-blue eyes
        [new BABYLON.Color3(0.10,0.04,0.03), new BABYLON.Color3(1.0,0.55,0.0),   new BABYLON.Color3(1.0,0.4,0.0)],  // Brute   – dark crimson, amber eyes
        [new BABYLON.Color3(0.05,0.03,0.11), new BABYLON.Color3(1.0,0.05,0.05),  new BABYLON.Color3(1.0,0.0,0.0)]   // Wraith  – deep purple, blood-red eyes
    ];

    function spawnMonster(idx){
        var root=new BABYLON.TransformNode('mr'+idx,scene);
        root.position.set(MSTARTS[idx].x,0,MSTARTS[idx].z);

        var bodyM=new BABYLON.StandardMaterial('bm'+idx,scene);
        bodyM.diffuseColor=MCFG[idx][0];
        bodyM.specularColor=new BABYLON.Color3(0.06,0.02,0.10);
        var eyeM=new BABYLON.StandardMaterial('em'+idx,scene);
        eyeM.emissiveColor=MCFG[idx][1]; eyeM.disableLighting=true;

        function part(nm,w,h,d,x,y,z){
            var m=BABYLON.MeshBuilder.CreateBox(nm+idx,{width:w,height:h,depth:d},scene);
            m.position.set(x,y,z); m.material=bodyM; m.parent=root; return m;
        }

        var aL,aR,lL,lR,eyeY,eyeZ;

        if(idx===0){
            // ── THE STALKER: tall, thin, long dragging arms, cold blue-white eyes ──
            part('bd',0.62,1.80,0.48,  0, 1.05,0);
            part('nk',0.18,0.50,0.18,  0, 1.90,0);
            part('hd',0.55,0.52,0.50,  0, 2.22,0);
            aL=part('aL',0.16,1.55,0.16,-0.52,1.05,0);
            aR=part('aR',0.16,1.55,0.16, 0.52,1.05,0);
            aL.rotation.z= 0.12; aR.rotation.z=-0.12;  // arms hang nearly straight
            lL=part('lL',0.20,1.15,0.20,-0.20,0.42,0);
            lR=part('lR',0.20,1.15,0.20, 0.20,0.42,0);
            part('fL',0.22,0.10,0.42,-0.20,0.06,0.10);
            part('fR',0.22,0.10,0.42, 0.20,0.06,0.10);
            eyeY=2.34; eyeZ=0.26;
            var eL0=BABYLON.MeshBuilder.CreateSphere('eL'+idx,{diameter:0.09,segments:6},scene);
            eL0.position.set(-0.14,eyeY,eyeZ); eL0.material=eyeM; eL0.parent=root;
            var eR0=BABYLON.MeshBuilder.CreateSphere('eR'+idx,{diameter:0.09,segments:6},scene);
            eR0.position.set( 0.14,eyeY,eyeZ); eR0.material=eyeM; eR0.parent=root;

        } else if(idx===1){
            // ── THE BRUTE: wide, squat, crouching, thick limbs, amber eyes ──
            root.position.y=-0.18;  // hunkered low
            part('bd',1.25,1.05,0.88,  0, 1.05,0);  // massive wide body
            part('hd',1.00,0.52,0.72,  0, 1.68,0.08); // flat wide head, thrust fwd
            // no neck – head sits directly on body
            aL=part('aL',0.38,1.25,0.38,-0.95,1.02,0);
            aR=part('aR',0.38,1.25,0.38, 0.95,1.02,0);
            aL.rotation.z= 0.58; aR.rotation.z=-0.58;  // arms spread wide at sides
            lL=part('lL',0.48,0.58,0.48,-0.32,0.36,0);
            lR=part('lR',0.48,0.58,0.48, 0.32,0.36,0);
            part('fL',0.46,0.14,0.60,-0.32,0.05,0.14);
            part('fR',0.46,0.14,0.60, 0.32,0.05,0.14);
            eyeY=1.72; eyeZ=0.38;
            var eL1=BABYLON.MeshBuilder.CreateSphere('eL'+idx,{diameter:0.16,segments:6},scene);
            eL1.position.set(-0.30,eyeY,eyeZ); eL1.material=eyeM; eL1.parent=root;
            var eR1=BABYLON.MeshBuilder.CreateSphere('eR'+idx,{diameter:0.16,segments:6},scene);
            eR1.position.set( 0.30,eyeY,eyeZ); eR1.material=eyeM; eR1.parent=root;

        } else {
            // ── THE WRAITH: towering, wispy, tendril limbs, blood-red eyes ──
            part('bd',0.38,2.50,0.32,  0, 1.35,0);  // impossibly tall thin body
            part('hd',0.44,0.95,0.38,  0, 2.82,0);  // elongated skull
            aL=part('aL',0.10,1.75,0.10,-0.30,1.55,0.04);
            aR=part('aR',0.10,1.75,0.10, 0.30,1.55,0.04);
            aL.rotation.z= 0.22; aR.rotation.z=-0.22;
            // trailing tendrils instead of solid legs
            lL=part('lL',0.09,1.30,0.09,-0.10,0.48,0.02);
            lR=part('lR',0.09,1.30,0.09, 0.10,0.48,-0.02);
            part('td1',0.07,1.00,0.07,-0.24,0.46, 0.06);
            part('td2',0.07,0.85,0.07, 0.24,0.42,-0.06);
            eyeY=2.94; eyeZ=0.20;
            var eL2=BABYLON.MeshBuilder.CreateSphere('eL'+idx,{diameter:0.12,segments:6},scene);
            eL2.position.set(-0.10,eyeY,eyeZ); eL2.material=eyeM; eL2.parent=root;
            var eR2=BABYLON.MeshBuilder.CreateSphere('eR'+idx,{diameter:0.12,segments:6},scene);
            eR2.position.set( 0.10,eyeY,eyeZ); eR2.material=eyeM; eR2.parent=root;
        }

        // Eye glow point light
        var gl=new BABYLON.PointLight('eg'+idx,new BABYLON.Vector3(0,eyeY,eyeZ+0.2),scene);
        gl.parent=root; gl.diffuse=MCFG[idx][2]; gl.intensity=0.35; gl.range=7;
        return {root:root,aL:aL,aR:aR,lL:lL,lR:lR,patrolIndex:0,chasing:false,stepT:0};
    }
    var monsters=[];
    for(var mi=0;mi<currentNight;mi++) monsters.push(spawnMonster(mi));

    var PATROL_SPD=2.2,CHASE_SPD=5.5,SIGHT=14,CATCH=1.3;

    // ── Movement ──────────────────────────────────────────────────────────────
    var BOUNDS=29.4,PR=0.45;
    function wallBlocked(x,z){
        var inW=(x-PR<-4.85&&x+PR>-5.15);
        var inE=(x-PR< 5.15&&x+PR> 4.85);
        var dS=(z>-18&&z<-10),dN=(z>12&&z<20);
        return (inW||inE)&&!dS&&!dN;
    }
    function furBlocked(x,z){
        for(var i=0;i<furBB.length;i++){
            var f=furBB[i];
            if(x+PR>f.x1&&x-PR<f.x2&&z+PR>f.z1&&z-PR<f.z2) return true;
        }
        return false;
    }
    function blocked(x,z){ return wallBlocked(x,z)||furBlocked(x,z); }
    function movePlayer(dx,dz){
        var cx=camera.position.x,cz=camera.position.z;
        var nx=Math.max(-BOUNDS,Math.min(BOUNDS,cx+dx));
        var nz=Math.max(-BOUNDS,Math.min(BOUNDS,cz+dz));
        if(!blocked(nx,nz)){camera.position.x=nx;camera.position.z=nz;return;}
        if(!blocked(nx,cz)){camera.position.x=nx;return;}
        if(!blocked(cx,nz)) camera.position.z=nz;
    }

    // ── Keys ──────────────────────────────────────────────────────────────────
    window.addEventListener('keydown',function(e){
        keys[e.code]=true;
        if(e.code==='KeyF'){flashOn=!flashOn; flashlight.intensity=flashOn?1.6:0;}
        if(e.code==='KeyR'&&(ISTATE==='gameover'||ISTATE==='wrong')) location.reload();
    });
    window.addEventListener('keyup',function(e){keys[e.code]=false;});

    document.querySelectorAll('.m-btn').forEach(function(btn){
        btn.addEventListener('click',function(){
            mysteryScreen.classList.add('hidden'); gamePaused=false;
            if(btn.dataset.ok==='1'){
                if(currentNight<3){ showNightClear(); }
                else { triggerFinalScene(); }
            } else {
                ISTATE='wrong'; gamePaused=true; wrongScreen.classList.remove('hidden');
            }
        });
    });

    // ── Render loop ───────────────────────────────────────────────────────────
    started=true;
    startAmbient();
    showMessage(ENTER_MSGS[currentNight-1],6);
    canvas.focus();
    canvas.requestPointerLock();

    var walkT=0, heartOn=false, targetFog=0.018, closestDist=999;

    scene.onBeforeRenderObservable.add(function(){
        if(gameOver||!started) return;
        var dt=engine.getDeltaTime()/1000;
        clueT+=dt;

        // Animate clues
        activeClues.forEach(function(c){
            if(!c.collected){
                c.pivot.rotation.y=clueT*1.3;
                c.pivot.position.y=1.0+Math.sin(clueT*2)*0.12;
            }
        });

        // Flicker sconces, fireplace, and candle
        sconceList.forEach(function(s){
            var flick=s.base+Math.sin(clueT*37+s.base*100)*0.03
                            +Math.sin(clueT*91+s.base*200)*0.015
                            +(Math.random()<0.002?-0.25:0); // rare dip
            s.light.intensity=Math.max(0.05,flick);
            var br=s.light.intensity/s.base;
            if(s.glowMat) s.glowMat.emissiveColor=new BABYLON.Color3(0.9*br,0.5*br,0.1*br);
        });

        // Message fade
        if(msgTimer>0){msgTimer-=dt; if(msgTimer<=0) msgEl.classList.remove('visible');}

        // Smooth fog
        scene.fogDensity+=(targetFog-scene.fogDensity)*dt*1.5;

        if(gamePaused) return;

        // Movement
        var spd=7.0*dt;
        var fwd=camera.getForwardRay(1).direction;
        var right=BABYLON.Vector3.Cross(fwd,BABYLON.Vector3.Up()).normalize();
        var dx=0,dz=0;
        if(keys['KeyW']||keys['ArrowUp'])   {dx+=fwd.x*spd;  dz+=fwd.z*spd;}
        if(keys['KeyS']||keys['ArrowDown']) {dx-=fwd.x*spd;  dz-=fwd.z*spd;}
        if(keys['KeyA']||keys['ArrowLeft']) {dx-=right.x*spd;dz-=right.z*spd;}
        if(keys['KeyD']||keys['ArrowRight']){dx+=right.x*spd;dz+=right.z*spd;}
        if(dx||dz){
            movePlayer(dx,dz);
            walkT+=dt;
            camera.position.y=1.6+Math.sin(walkT*9)*0.055;
            // Footsteps
            if(clueT-lastStep>0.38){playStep();lastStep=clueT;}
        } else {
            camera.position.y+=((1.6-camera.position.y))*dt*8;
        }

        // Clue pickup
        var px=camera.position.x,pz=camera.position.z;
        activeClues.forEach(function(c){
            if(c.collected) return;
            var dx2=c.pivot.position.x-px,dz2=c.pivot.position.z-pz;
            if(Math.sqrt(dx2*dx2+dz2*dz2)<2.8){
                c.collected=true; c.pivot.setEnabled(false); c.light.intensity=0;
                cluesFound++; clueCountEl.textContent=cluesFound;
                playClueChime();
                if(cluesFound>=2){
                    allCluesFound=true;
                    exitLight.intensity=0.7;
                    exitGlowM.emissiveColor=new BABYLON.Color3(0.02,0.14,0.03);
                }
                showCluePopup(c.data);
            }
        });

        // Front door exit — triggers night clear (N1/N2) or mystery (N3)
        if(allCluesFound && !gamePaused && !nightDone){
            if(pz < -27.2 && Math.abs(px) < 3.5){
                if(currentNight<3){ showNightClear(); }
                else { gamePaused=true; solveBarEl.classList.add('hidden'); mysteryScreen.classList.remove('hidden'); try{document.exitPointerLock();}catch(e){} }
            }
        }

        // Monster AI
        var nowChasing=false;
        closestDist=999;
        monsters.forEach(function(m,idx){
            var mx=m.root.position.x,mz=m.root.position.z;
            var pdx=px-mx,pdz=pz-mz;
            var dist=Math.sqrt(pdx*pdx+pdz*pdz);
            if(dist<closestDist) closestDist=dist;

            // Animate limbs
            var sw=Math.sin(clueT*(m.chasing?8:4))*0.45;
            m.aL.rotation.x= sw; m.aR.rotation.x=-sw;
            m.lL.rotation.x=-sw*0.7; m.lR.rotation.x= sw*0.7;

            // Monster footstep sound
            m.stepT=(m.stepT||0)+dt;
            if(dist<20&&m.stepT>0.55){
                var vol=Math.max(0,(20-dist)/20);
                if(audioCtx&&vol>0.1){
                    var buf=audioCtx.createBuffer(1,Math.floor(audioCtx.sampleRate*0.12),audioCtx.sampleRate);
                    var d2=buf.getChannelData(0);
                    for(var si=0;si<d2.length;si++) d2[si]=(Math.random()*2-1)*Math.exp(-si/d2.length*12)*vol*0.5;
                    var src=audioCtx.createBufferSource(),gg=audioCtx.createGain();
                    gg.gain.value=0.6; src.buffer=buf;
                    src.connect(gg); gg.connect(audioCtx.destination); src.start();
                }
                m.stepT=0;
            }

            if(dist<SIGHT){
                nowChasing=true; m.chasing=true;
                if(dist<CATCH){
                    triggerJumpscare(idx); return;
                }
                m.root.position.x+=pdx/dist*CHASE_SPD*dt;
                m.root.position.z+=pdz/dist*CHASE_SPD*dt;
                m.root.rotation.y=Math.atan2(pdx,pdz);
            } else {
                m.chasing=false;
                var pts=PATROL_ROUTES[idx],tgt=pts[m.patrolIndex];
                var tdx=tgt.x-mx,tdz=tgt.z-mz,tdl=Math.sqrt(tdx*tdx+tdz*tdz);
                if(tdl<0.5){ m.patrolIndex=(m.patrolIndex+1)%pts.length; }
                else {
                    m.root.position.x+=tdx/tdl*PATROL_SPD*dt;
                    m.root.position.z+=tdz/tdl*PATROL_SPD*dt;
                    m.root.rotation.y=Math.atan2(tdx,tdz);
                }
            }
        });

        // Chase audio + fog + heartbeat
        if( nowChasing&&!anyChasing) startChase();
        if(!nowChasing&& anyChasing) stopChase();
        anyChasing=nowChasing;
        targetFog=nowChasing?0.034:0.018;

        var heartNow=closestDist<10;
        if( heartNow&&!heartOn){startHeartbeat();heartOn=true;}
        if(!heartNow&& heartOn){stopHeartbeat(); heartOn=false;}

        // Growl when nearby
        growlTimer-=dt;
        if(closestDist<20&&growlTimer<=0){playGrowl();growlTimer=3+Math.random()*4;}

        // Camera shake when monster very close
        if(closestDist<5){
            var shk=(5-closestDist)/5*0.007;
            camera.rotation.y=camYaw+(Math.random()-0.5)*shk;
            camera.rotation.x=camPitch+(Math.random()-0.5)*shk;
        }

        // Intensify vignette when chasing
        imgProc.vignetteWeight=nowChasing
            ? 4.0+Math.sin(clueT*3)*1.5
            : 4.0;
    });

    engine.runRenderLoop(function(){scene.render();});
    window.addEventListener('resize',function(){engine.resize();});
}
