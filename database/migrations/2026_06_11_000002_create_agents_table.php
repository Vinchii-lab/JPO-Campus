<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('agents', function (Blueprint $table) {
            $table->id();
            $table->string('name');
            $table->string('department');
            $table->string('color', 7);
            $table->string('hometown');
            $table->string('fun_fact');
            $table->enum('status', ['available', 'in_call', 'afk'])->default('available');
            $table->integer('position_x')->default(0);
            $table->integer('position_y')->default(0);
            $table->foreignId('room_id')->nullable()->constrained()->nullOnDelete();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('agents');
    }
};
