<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class Agent extends Model
{
    protected $fillable = [
        'name',
        'department',
        'color',
        'hometown',
        'fun_fact',
        'status',
        'position_x',
        'position_y',
        'room_id',
    ];
}
