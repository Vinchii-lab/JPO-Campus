<?php

use App\Http\Controllers\AgentController;
use App\Http\Controllers\CampusController;
use Illuminate\Support\Facades\Route;

Route::get('/', [AgentController::class, 'showLogin'])->name('login.show');
Route::post('/login', [AgentController::class, 'login'])->name('agent.login');

Route::get('/campus', [CampusController::class, 'index'])->name('campus');
