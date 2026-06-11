<?php

namespace App\Http\Controllers;

use App\Models\Agent;
use Illuminate\Http\Request;
use Inertia\Inertia;

class AgentController extends Controller
{
    public function showLogin()
    {
        return Inertia::render('Login');
    }

    public function login(Request $request)
    {
        $data = $request->validate([
            'name'       => 'required|string|max:100',
            'department' => 'required|in:Marketing,Engagement,HR,Accounting,Operations',
            'color'      => 'required|in:#6366F1,#EC4899,#F59E0B,#10B981,#3B82F6,#EF4444',
        ]);

        $agent = Agent::create([
            ...$data,
            'hometown' => '',
            'fun_fact' => '',
        ]);

        session(['agent_id' => $agent->id]);

        return Inertia::location('/campus');
    }
}
