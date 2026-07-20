// chamando valores
const canvas = document.getElementById('game')
const ctx = canvas.getContext('2d')
const score = document.getElementById('score')
const restart = document.getElementById('restart')
//
// criando variaveis

let snake = [];
let food = {};
let gridsize = 20;
let gameover = false
let gameinterval;
// criando cobra parada
ctx.clearRect(0, 0, canvas.Width, canvas.height);
ctx.fillStyle = 'lime';
ctx.fillRect(20, 20 ,20 ,20 );

