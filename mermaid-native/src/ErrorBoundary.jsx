import React from 'react';
import SectionMessage from '@atlaskit/section-message';

export default class DiagramErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('Mermaid diagram crashed:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <SectionMessage appearance="error" title="This diagram failed to render">
          <p>{this.state.error.message || String(this.state.error)}</p>
        </SectionMessage>
      );
    }
    return this.props.children;
  }
}
