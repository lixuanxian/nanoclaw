import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Form, Input, Button, Typography } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import { login } from '../api';
import { useT } from '../i18n';

const { Title, Text } = Typography;

export function LoginPage() {
  const { t } = useT();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const onFinish = async (values: { password: string }) => {
    setLoading(true);
    setError('');
    try {
      const ok = await login(values.password);
      if (ok) {
        navigate('/', { replace: true });
      } else {
        setError(t('login.error'));
      }
    } catch {
      setError(t('login.error'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        {/* Logo */}
        <div className="login-logo">
          <div className="login-logo-icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
          </div>
          <Title level={3} style={{ margin: 0, fontWeight: 700, letterSpacing: '-0.5px' }}>
            NanoClaw
          </Title>
          <Text style={{ color: 'var(--ant-color-text-tertiary)', fontSize: 13 }}>
            {t('login.subtitle')}
          </Text>
        </div>

        {/* Form */}
        <Form onFinish={onFinish} autoComplete="off" style={{ width: '100%' }}>
          <Form.Item
            name="password"
            rules={[{ required: true, message: '' }]}
            validateStatus={error ? 'error' : undefined}
            help={error || undefined}
          >
            <Input.Password
              prefix={<LockOutlined style={{ color: 'var(--ant-color-text-quaternary)' }} />}
              placeholder={t('login.password')}
              size="large"
              style={{ borderRadius: 10, height: 44 }}
              onFocus={() => setError('')}
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <Button
              type="primary"
              htmlType="submit"
              loading={loading}
              block
              size="large"
              style={{ borderRadius: 10, height: 44, fontWeight: 600 }}
            >
              {t('login.submit')}
            </Button>
          </Form.Item>
        </Form>
      </div>
    </div>
  );
}
