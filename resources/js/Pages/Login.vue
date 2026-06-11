<script setup>
import { Head, useForm } from '@inertiajs/vue3'

const DEPARTMENTS = ['Marketing', 'Engagement', 'HR', 'Accounting', 'Operations']

const COLORS = [
  { label: 'Indigo',  value: '#6366F1' },
  { label: 'Pink',    value: '#EC4899' },
  { label: 'Amber',   value: '#F59E0B' },
  { label: 'Emerald', value: '#10B981' },
  { label: 'Blue',    value: '#3B82F6' },
  { label: 'Red',     value: '#EF4444' },
]

const form = useForm({
  name:       '',
  department: '',
  color:      '',
})

function submit() {
  form.post('/login')
}
</script>

<template>
  <Head title="Enter Campus" />

  <div class="min-h-screen flex items-center justify-center bg-[#0F0E17]">

    <!-- Subtle radial glow behind the card -->
    <div
      class="pointer-events-none absolute inset-0"
      style="background: radial-gradient(ellipse 60% 50% at 50% 40%, rgba(83,74,183,0.18) 0%, transparent 70%)"
    />

    <div class="relative w-full max-w-md px-6">

      <!-- Logo / wordmark -->
      <div class="mb-10 text-center">
        <span class="text-3xl font-bold tracking-tight text-white">JPO <span class="text-[#534AB7]">Campus</span></span>
        <p class="mt-1 text-sm text-white/40">Virtual office for the JPO team</p>
      </div>

      <!-- Card -->
      <div class="rounded-2xl border border-white/10 bg-white/5 p-8 shadow-2xl backdrop-blur-sm">

        <h2 class="mb-6 text-lg font-semibold text-white">Who are you?</h2>

        <form @submit.prevent="submit" class="space-y-5">

          <!-- Name -->
          <div>
            <label class="mb-1.5 block text-xs font-medium uppercase tracking-widest text-white/50">
              Your name
            </label>
            <input
              v-model="form.name"
              type="text"
              placeholder="e.g. Vince"
              class="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm text-white placeholder-white/25 outline-none transition focus:border-[#534AB7] focus:ring-1 focus:ring-[#534AB7]"
              required
            />
            <p v-if="form.errors.name" class="mt-1 text-xs text-red-400">{{ form.errors.name }}</p>
          </div>

          <!-- Department -->
          <div>
            <label class="mb-1.5 block text-xs font-medium uppercase tracking-widest text-white/50">
              Department
            </label>
            <select
              v-model="form.department"
              class="w-full rounded-lg border border-white/10 bg-[#1A1830] px-4 py-3 text-sm text-white outline-none transition focus:border-[#534AB7] focus:ring-1 focus:ring-[#534AB7]"
              required
            >
              <option value="" disabled>Select your department…</option>
              <option v-for="dept in DEPARTMENTS" :key="dept" :value="dept">{{ dept }}</option>
            </select>
            <p v-if="form.errors.department" class="mt-1 text-xs text-red-400">{{ form.errors.department }}</p>
          </div>

          <!-- Avatar Color -->
          <div>
            <label class="mb-2 block text-xs font-medium uppercase tracking-widest text-white/50">
              Avatar color
            </label>
            <div class="flex gap-3">
              <button
                v-for="c in COLORS"
                :key="c.value"
                type="button"
                :title="c.label"
                @click="form.color = c.value"
                class="h-8 w-8 rounded-full transition-transform hover:scale-110 focus:outline-none"
                :style="{ backgroundColor: c.value }"
                :class="form.color === c.value
                  ? 'ring-2 ring-white ring-offset-2 ring-offset-[#0F0E17] scale-110'
                  : 'opacity-60'"
              />
            </div>
            <p v-if="form.errors.color" class="mt-1 text-xs text-red-400">{{ form.errors.color }}</p>
          </div>

          <!-- Submit -->
          <button
            type="submit"
            :disabled="form.processing || !form.name || !form.department || !form.color"
            class="mt-2 w-full rounded-lg bg-[#534AB7] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#6257CC] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span v-if="form.processing">Entering…</span>
            <span v-else>Enter Campus</span>
          </button>

        </form>
      </div>
    </div>
  </div>
</template>
