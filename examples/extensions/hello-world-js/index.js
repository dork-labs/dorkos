export function activate(api) {
  const unregisterSection = api.registerComponent(
    'dashboard.sections',
    'hello-js',
    function HelloJS() {
      return React.createElement(
        'div',
        {
          style: {
            padding: '16px',
            border: '1px solid var(--border)',
            borderRadius: '12px',
          },
        },
        React.createElement(
          'h3',
          { style: { margin: 0, fontSize: '14px', fontWeight: 600 } },
          'Hello World (JS)'
        ),
        React.createElement(
          'p',
          { style: { margin: '8px 0 0', fontSize: '13px', color: 'var(--muted-foreground)' } },
          'This section was added by the pre-compiled JS extension.'
        )
      );
    },
    { priority: 91 }
  );

  return () => {
    unregisterSection();
  };
}
