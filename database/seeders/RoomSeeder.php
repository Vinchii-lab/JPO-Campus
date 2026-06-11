<?php

namespace Database\Seeders;

use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;

class RoomSeeder extends Seeder
{
    public function run(): void
    {
        $rooms = [
            ['name' => 'HQ',          'icon' => '🏢', 'color' => '#4F46E5'],
            ['name' => 'Marketing',   'icon' => '📣', 'color' => '#EC4899'],
            ['name' => 'Engagement',  'icon' => '🤝', 'color' => '#F59E0B'],
            ['name' => 'HR',          'icon' => '👥', 'color' => '#10B981'],
            ['name' => 'Accounting',  'icon' => '💰', 'color' => '#3B82F6'],
            ['name' => 'Operations',  'icon' => '⚙️', 'color' => '#8B5CF6'],
            ['name' => 'Canteen',     'icon' => '🍽️', 'color' => '#EF4444'],
        ];

        foreach ($rooms as $room) {
            DB::table('rooms')->insertOrIgnore([
                ...$room,
                'created_at' => now(),
                'updated_at' => now(),
            ]);
        }
    }
}
