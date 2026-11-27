<?php
/**
 * Plugin Name: Mentez — Agendamento on-line e WhatsApp
 * Description: Coloca no site o botão flutuante de WhatsApp (atendente virtual ou WhatsApp da clínica) e a seção de Agendamento on-line integrada à Mentez. Textos, número e regras são configurados na própria Mentez (Configurações → Agendamento online).
 * Version: 1.1.0
 * Author: Mentez
 * Author URI: https://mentez.com.br
 * Requires at least: 5.6
 * Requires PHP: 7.2
 * License: GPLv2 or later
 * Text Domain: mentez-agendamento
 */

if (!defined('ABSPATH')) exit;

define('MENTEZ_AG_VERSION', '1.1.0');
define('MENTEZ_AG_DEFAULT_URL', '__MENTEZ_URL__'); // preenchido ao baixar o plugin pela Mentez

function mentez_ag_opts() {
	$d = array(
		'url' => strpos(MENTEZ_AG_DEFAULT_URL, '__') === 0 ? '' : MENTEZ_AG_DEFAULT_URL,
		'botao' => 1, 'posicao' => 'direita', 'trocar' => 1, 'inicio' => 1, 'page_id' => 0,
	);
	$o = get_option('mentez_agendamento', array());
	return array_merge($d, is_array($o) ? $o : array());
}
function mentez_ag_url() {
	$u = trim((string) mentez_ag_opts()['url']);
	return $u ? untrailingslashit(esc_url_raw($u)) : '';
}

// ---------- script da Mentez em todas as páginas ----------
add_action('wp_enqueue_scripts', function () {
	$u = mentez_ag_url(); if (!$u) return;
	wp_enqueue_script('mentez-site', $u . '/agendar/site.js', array(), null, true);
});
add_filter('script_loader_tag', function ($tag, $handle) {
	if ($handle !== 'mentez-site') return $tag;
	$o = mentez_ag_opts();
	$attrs = ' async';
	if (empty($o['botao'])) $attrs .= ' data-botao="nao"';
	if ($o['posicao'] === 'esquerda') $attrs .= ' data-posicao="esquerda"';
	if (!empty($o['trocar'])) $attrs .= ' data-trocar="sim"';
	return str_replace(' src=', $attrs . ' src=', $tag);
}, 10, 2);

// ---------- seção de Agendamento on-line: [mentez_agendamento titulo="..." texto="..."] ----------
function mentez_ag_section($atts = array()) {
	$a = shortcode_atts(array('titulo' => '', 'texto' => '', 'cor' => ''), $atts, 'mentez_agendamento');
	$u = mentez_ag_url();
	if (!$u) return current_user_can('manage_options') ? '<p><em>Mentez: informe o endereço do sistema em Configurações → Mentez.</em></p>' : '';
	$out = '<div data-mentez-agendar';
	if ($a['titulo'] !== '') $out .= ' data-titulo="' . esc_attr($a['titulo']) . '"';
	if ($a['texto'] !== '') $out .= ' data-texto="' . esc_attr($a['texto']) . '"';
	if (preg_match('/^#[0-9a-fA-F]{3,8}$/', $a['cor'])) $out .= ' data-cor="' . esc_attr($a['cor']) . '"';
	// sem JavaScript (ou antes de carregar), fica um link para a página de agendamento
	$out .= '><p style="text-align:center;padding:40px 0"><a href="' . esc_url($u . '/agendar') . '" target="_blank" rel="noopener">Agendar consulta on-line</a></p></div>';
	return $out;
}
add_shortcode('mentez_agendamento', 'mentez_ag_section');

// Página inicial: a seção entra no fim do conteúdo (se a página ainda não tiver o atalho)
add_filter('the_content', function ($content) {
	$o = mentez_ag_opts();
	if (empty($o['inicio']) || !is_front_page() || !in_the_loop() || !is_main_query()) return $content;
	if (has_shortcode($content, 'mentez_agendamento') || strpos($content, 'data-mentez-agendar') !== false) return $content;
	return $content . mentez_ag_section();
}, 20);

// Ao ativar: cria a página “Agendamento on-line” com a seção (uma vez só)
register_activation_hook(__FILE__, function () {
	$o = mentez_ag_opts();
	if (!empty($o['page_id']) && get_post_status((int) $o['page_id'])) return;
	$exists = get_page_by_path('agendamento-online');
	$id = $exists ? $exists->ID : wp_insert_post(array(
		'post_title' => 'Agendamento on-line', 'post_name' => 'agendamento-online', 'post_status' => 'publish', 'post_type' => 'page',
		'post_content' => "<!-- wp:shortcode -->\n[mentez_agendamento]\n<!-- /wp:shortcode -->",
	));
	if ($id && !is_wp_error($id)) { $o['page_id'] = (int) $id; update_option('mentez_agendamento', $o); }
});

// ---------- Configurações → Mentez ----------
add_action('admin_menu', function () {
	add_options_page('Mentez — Agendamento', 'Mentez', 'manage_options', 'mentez-agendamento', 'mentez_ag_admin');
});
add_filter('plugin_action_links_' . plugin_basename(__FILE__), function ($l) {
	array_unshift($l, '<a href="' . esc_url(admin_url('options-general.php?page=mentez-agendamento')) . '">Configurar</a>');
	return $l;
});
add_action('admin_post_mentez_ag_save', function () {
	if (!current_user_can('manage_options')) wp_die('Sem permissão.');
	check_admin_referer('mentez_ag_save');
	$o = mentez_ag_opts();
	$url = isset($_POST['url']) ? trim(wp_unslash($_POST['url'])) : '';
	if ($url && !preg_match('#^https?://#i', $url)) $url = 'https://' . $url;
	$url = preg_replace('#/(agendar.*)?$#', '', $url);
	$o['url'] = esc_url_raw($url);
	$o['botao'] = empty($_POST['botao']) ? 0 : 1;
	$o['trocar'] = empty($_POST['trocar']) ? 0 : 1;
	$o['inicio'] = empty($_POST['inicio']) ? 0 : 1;
	$o['posicao'] = (isset($_POST['posicao']) && $_POST['posicao'] === 'esquerda') ? 'esquerda' : 'direita';
	update_option('mentez_agendamento', $o);
	wp_safe_redirect(admin_url('options-general.php?page=mentez-agendamento&salvo=1')); exit;
});
function mentez_ag_admin() {
	$o = mentez_ag_opts(); $u = mentez_ag_url();
	$page = !empty($o['page_id']) ? get_permalink((int) $o['page_id']) : '';
	?>
	<div class="wrap">
		<h1>Mentez — Agendamento on-line e WhatsApp</h1>
		<?php if (!empty($_GET['salvo'])) echo '<div class="notice notice-success is-dismissible"><p>Configurações salvas.</p></div>'; ?>
		<p>O número do WhatsApp, os textos e as regras de horários são configurados na Mentez, em <b>Configurações → Agendamento online</b>.
			<?php if ($u) echo '<a href="' . esc_url($u . '/configuracoes/agendamento-online') . '" target="_blank" rel="noopener">Abrir na Mentez ↗</a>'; ?></p>
		<form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
			<input type="hidden" name="action" value="mentez_ag_save"><?php wp_nonce_field('mentez_ag_save'); ?>
			<table class="form-table" role="presentation">
				<tr><th scope="row"><label for="mz-url">Endereço do sistema</label></th>
					<td><input id="mz-url" name="url" type="url" class="regular-text" placeholder="https://suaclinica.mentez.com.br" value="<?php echo esc_attr($o['url']); ?>">
					<p class="description">O endereço em que a clínica entra na Mentez.</p></td></tr>
				<tr><th scope="row">Botão de WhatsApp</th>
					<td><label><input type="checkbox" name="botao" value="1" <?php checked($o['botao']); ?>> Mostrar o botão flutuante em todas as páginas</label><br>
					<label>Posição <select name="posicao"><option value="direita" <?php selected($o['posicao'], 'direita'); ?>>Canto direito</option><option value="esquerda" <?php selected($o['posicao'], 'esquerda'); ?>>Canto esquerdo</option></select></label><br>
					<label><input type="checkbox" name="trocar" value="1" <?php checked($o['trocar']); ?>> Trocar os links de WhatsApp que já existem no site pelo número escolhido na Mentez</label>
					<p class="description">Se outro plugin já mostra um botão de WhatsApp (ex.: Joinchat, Click to Chat), desative-o para não aparecerem dois.</p></td></tr>
				<tr><th scope="row">Seção de agendamento</th>
					<td><label><input type="checkbox" name="inicio" value="1" <?php checked($o['inicio']); ?>> Mostrar no fim da página inicial</label>
					<p class="description">Em qualquer outra página ou bloco, use o atalho <code>[mentez_agendamento]</code> (bloco “Código curto”). Para mudar o título e a cor: <code>[mentez_agendamento titulo="Agende sua sessão" cor="#0ea5e9"]</code>.<br>
					Para um botão do site abrir o WhatsApp escolhido, use o link <code>#whatsapp</code>; para levar à seção, <code>#agendar</code>.</p>
					<?php if ($page) echo '<p>Página exclusiva: <a href="' . esc_url($page) . '" target="_blank" rel="noopener">' . esc_html($page) . '</a></p>'; ?></td></tr>
			</table>
			<?php submit_button('Salvar'); ?>
		</form>
	</div>
	<?php
}
