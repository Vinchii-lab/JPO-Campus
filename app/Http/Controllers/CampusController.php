<?php

namespace App\Http\Controllers;

use Inertia\Inertia;

class CampusController extends Controller
{
    public function index()
    {
        return Inertia::render('Campus');
    }
}
