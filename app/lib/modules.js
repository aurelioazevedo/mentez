// Módulos que cada clínica liga ou desliga em Configurações (hoje: Exercícios).
// Exercícios: os cadernos de folhas foram feitos para a Dra. Lorrainy; na Mentez o módulo vem desligado,
// menos nas clínicas da Dra. Lorrainy e do Dr. Aurélio. Sem a plataforma (sistema de uma clínica só), ligado.
import { getSetting, setSetting } from './db.js';
import * as Tenancy from './tenancy.js';
import { FEATURES } from './html.js';

const ON_BY_DEFAULT = ['lorrainy', 'aurelio'];
const defaultExercises = () => !Tenancy.multi() || ON_BY_DEFAULT.includes(Tenancy.current()?.slug);
export async function exercisesOn() {
  const v = await getSetting('mod_exercicios').catch(() => null);
  const on = v === '1' ? true : v === '0' ? false : defaultExercises();
  FEATURES.exercicios = on;
  return on;
}
export async function setExercises(on) { await setSetting('mod_exercicios', on ? '1' : '0'); FEATURES.exercicios = !!on; }
