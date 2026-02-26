import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Form, Input, Button, Typography, Alert } from 'antd';
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
    <div style={{
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      minHeight: '100%',
      background: 'var(--ant-color-bg-layout)',
    }}>
      <Card style={{ width: 360, boxShadow: '0 2px 8px rgba(0,0,0,0.15)' }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <Title level={3} style={{ marginBottom: 4 }}>NanoClaw</Title>
          <Text type="secondary">{t('login.subtitle')}</Text>
        </div>

        {error && <Alert message={error} type="error" showIcon style={{ marginBottom: 16 }} />}

        <Form onFinish={onFinish} autoComplete="off">
          <Form.Item name="password" rules={[{ required: true, message: '' }]}>
            <Input.Password
              prefix={<LockOutlined />}
              placeholder={t('login.password')}
              size="large"
            />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading} block size="large">
              {t('login.submit')}
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
}
